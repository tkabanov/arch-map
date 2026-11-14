// Shared by the scene modules: the timings of the motion, the easing, HTML escaping.

// a level change: smoothstep, the same curve for the layout and the camera, so a block grows on screen steadily
export const ease = (t: number): number => t * t * (3 - 2 * t);
export const smooth = (t: number, a: number, b: number): number => ease(Math.max(0, Math.min(1, (t - a) / (b - a))));
export const MOVE_MS = 720; // layout tween and camera flight run together, for the same time
export const ENTER_MS = 900; // going in or out of a block: a little longer, it is the largest change on screen
export const EDGE_FADE_MS = 320; // rebuilt relations fade in instead of popping
export const EDGE_OUT_MS = 220; // the old ones fade out
export const OPACITY_RATE = 14; // 1/s: dimming and lighting (a focus, a selection) ease in over ~0.15 s
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
