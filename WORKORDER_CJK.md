# 工单：将 PMBrain 的 CJK bigram FTS 移植进 gbrain 0.50.0.0

你是执行者（pi），Hermes 是 PM 和验收人。严格按本工单施工，做完逐项自检并输出报告。

## 背景

- 本仓库是 gbrain 0.50.0.0 的 fork（herman6888/gbrain-code，master = v0.50.0.0 + 一个本地 shebang commit）。
- 现状问题：中文关键词搜索走 `_searchKeywordCJK`（逐词 ILIKE，无索引，全表扫描，见 postgres-engine.ts:1449 / pglite-engine.ts:2437）。
- 目标：中文查询改走 GIN 索引的 bigram FTS（PMBrain 已验证的设计），英文路径零改动。
- 参考实现（只读，勿改）：`/tmp/pmbrain-probe/`
  - `/tmp/pmbrain-probe/src/schema.sql:338-375` — `pmbrain_cjk_search_tokens()` 函数 + chunk trigger 模板
  - `/tmp/pmbrain-probe/src/core/migrate.ts:4985-5037` — PMBrain v109 迁移（函数+trigger+backfill）
  - `/tmp/pmbrain-probe/src/core/postgres-engine.ts:1665` — 读侧 CJK FTS 分支写法

## 命名约定

函数名一律用 **`gbrain_cjk_search_tokens`**（不要 pmbrain 前缀）。

## 施工项

### 1. schema.sql 模板（src/schema.sql）

在 `update_chunk_search_vector()`（约 362 行）之前新增函数：

```sql
CREATE OR REPLACE FUNCTION gbrain_cjk_search_tokens(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT string_agg(DISTINCT tok, ' ' ORDER BY tok)
  FROM (
    SELECT c AS tok
    FROM regexp_split_to_table(COALESCE(input, ''), '') c
    WHERE c ~ '[\u4e00-\u9fff\u3400-\u4dbf]'
    UNION ALL
    SELECT a.c || b.c AS tok
    FROM regexp_split_to_table(COALESCE(input, ''), '') a
    JOIN regexp_split_to_table(COALESCE(input, ''), '') b ON TRUE
    WHERE a.c ~ '[\u4e00-\u9fff\u3400-\u4dbf]'
      AND b.c ~ '[\u4e00-\u9fff\u3400-\u4dbf]'
      AND position(a.c || b.c IN COALESCE(input, '')) > 0
  ) t
$$;
```

（以 PMBrain schema.sql:338-375 的实际实现为准，上面只是骨架示意——照抄 PMBrain 的逻辑，只改函数名。）

然后修改 `update_chunk_search_vector()`：在现有 `to_tsvector('<lang>', ...)` 的基础上，把 chunk_text 的 CJK token 串以权重 A 或 B 并入同一个 tsvector（照抄 PMBrain 的 trigger 写法：`setweight(to_tsvector('simple', gbrain_cjk_search_tokens(NEW.chunk_text)), 'A')` 与英文部分拼接）。注意保持函数现有的其它列逻辑不变。

**pages 表的 trigger 不动**（PMBrain 也只索引 content_chunks）。

改完运行 `bun run build:schema` 重新生成 `src/core/schema-embedded.generated.ts`，确认生成文件包含新函数。

### 2. 迁移 v150（src/core/migrate.ts）

在 MIGRATIONS 数组末尾（v149 之后）追加 `version: 150`：
- CREATE FUNCTION gbrain_cjk_search_tokens（同上，幂等 CREATE OR REPLACE）
- DROP TRIGGER + CREATE TRIGGER（与 schema.sql 模板一致）
- 全表 backfill：`UPDATE content_chunks SET search_vector = <新表达式> WHERE chunk_text IS NOT NULL`（照抄 PMBrain v109 的 backfill，注意分批/锁的写法如果 PMBrain 有）
- 迁移必须幂等（可重跑）。

### 3. 读侧（两个引擎都要改，保持 parity）

**postgres-engine.ts** `searchKeyword`（约 1449 行）：
- hasCJK 分支改为走 FTS：score 用 `ts_rank(cc.search_vector, plainto_tsquery('simple', gbrain_cjk_search_tokens($1)))`，WHERE 用 `cc.search_vector @@ plainto_tsquery('simple', gbrain_cjk_search_tokens($1))`（照抄 PMBrain postgres-engine.ts:1665 的表达式，含 source factor 乘子等现有结构）。
- **保留 `_searchKeywordCJK` 作为兜底**：FTS 返回 0 结果时 fallback 到 ILIKE 路径（PMBrain 是直接删掉 ILIKE，我们更保守——这是与 PMBrain 的唯一设计差异，验收时 PM 会看）。

**pglite-engine.ts**（约 2437 行）：同样处理。

注意：`plainto_tsquery('simple', ...)` 的第二个参数是函数调用不是常量——确认 SQL 合法（PMBrain 已验证过这种写法）。若 Postgres 对函数参数位置有限制，用子查询或 CTE 包一层。

### 4. 测试

- 在现有测试目录加测试（找 `bun test` 已覆盖的 search 测试文件，仿照其结构）：
  - tokenizer：`gbrain_cjk_search_tokens('星云项目延期')` 应含单字和相邻 bigram
  - 中文搜索命中：导入含"负责人延期交付"的 chunk，搜"延期"命中
  - 英文搜索回归：现有英文 FTS 测试必须继续过
  - fallback：搜一个 FTS 不命中但 ILIKE 能命中的中文串（如含标点分隔），验证兜底路径

## 验收标准（PM 会独立复验）

1. `bun run build:schema && bun test` 全绿
2. 全新 PGLite 库：init → 导入中文文档 → `gbrain search "延期"` 命中且走 FTS（不是 ILIKE 兜底——可在代码里临时加日志或检查返回 score 结构）
3. `EXPLAIN` 中文 FTS 查询在 content_chunks 上走 `Bitmap Index Scan`（GIN），无 Seq Scan
4. 英文搜索行为与改动前一致
5. 迁移 v150 在已有库上可重跑（幂等）

## 禁区

- 不要动 pages 表 trigger、英文 FTS 路径、hybrid 融合逻辑
- 不要动 `src/core/search/cjk-keyword-sql.ts`（保留原样作兜底 SQL 源）
- 不要 git push（PM 审核后统一推）
- 不要碰生产库（:5434）——测试一律用 PGLite 或临时库

## 输出要求

完成后输出：改动文件清单、每个验收项的自测结果（含命令与关键输出）、未尽事项。
