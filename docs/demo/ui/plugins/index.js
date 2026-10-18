// What the island draws besides the cards of plugins: the faces they bring (a script in a frame) and the widgets and panes modules
// bring. The cards, the pills and the rings are drawn by ../pluginui.js, from the data a plugin hands the island.
import faces from "../faces.js";
import surface from "./surface.js";

export const plugins = [faces, surface];
