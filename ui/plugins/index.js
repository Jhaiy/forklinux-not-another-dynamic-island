// The faces of the native plugins that draw more than the blocks can (the plugin itself is in src/builtin): each file draws one
// plugin's cards and pill. A plugin that is switched off sends nothing, so its file has nothing to draw. Every other plugin
// (a module, a declarative plugin) is drawn by ../pluginui.js, from its data.
import claude from "./claude-code.js";
import downloads from "./downloads.js";
import games from "./games.js";
import pageReader from "./page-reader.js";
import faces from "../faces.js";
import surface from "./surface.js";

export const plugins = [claude, games, downloads, pageReader, faces, surface];
