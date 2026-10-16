/**
 * Wire-compatibility windows: fields a gbrain process still accepts from an older peer after it stopped using them.
 *
 * Master ships many PATCH releases a day, so a window counted in releases lasts hours. Each window is a calendar
 * period plus a version floor: a field is accepted (validated, then ignored) until `accept_until`, and only peers below
 * `floor` still send it. After `accept_until` the field may be deleted from the wire tables that cite its entry here.
 */
export interface WireSkewWindow { field: string; floor: string; accept_until: string; why: string }

export const WIRE_SKEW_WINDOWS = {
  /** #6712 PR 1: the managed cursor's processing options are inherited, so the explicit-flag list no longer decides anything. */
  explicitProcessing: { field: 'explicitProcessing', floor: '0.60.255.0', accept_until: '2026-11-14',
    why: 'Sync clients below the floor send the processing flags their user typed (#6317, #6696); a resume now inherits the cursor\'s opt-outs instead.' },
} as const satisfies Record<string, WireSkewWindow>;
