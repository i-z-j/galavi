/**
 * View Module
 *
 * Public extension surface for views. The `runtime/` subfolder (image
 * pipeline, scene uniform layout, view factory) is internal machinery —
 * imported directly by concrete views, not re-exported here.
 */

export { BaseView, type ViewClass } from "./base";
export { VolumeView } from "./volume";
export { SliceView } from "./slice";
export { NavigatorView } from "./navigator";
