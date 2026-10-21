const fs = require("node:fs");
const path = require("node:path");
// Original, deterministic vector artwork. No remote images or game textures.
let artwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 760"><defs><linearGradient id="sky" x2=".75" y2="1"><stop stop-color="#b4cdfb"/><stop offset=".55" stop-color="#d8dbfb"/><stop offset="1" stop-color="#c1e4ec"/></linearGradient><linearGradient id="haze" x2="0" y2="1"><stop stop-color="#f5f7ff" stop-opacity="0"/><stop offset="1" stop-color="#edf3fc" stop-opacity=".85"/></linearGradient><radialGradient id="light"><stop stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="1440" height="760" fill="url(#sky)"/><ellipse cx="1110" cy="160" rx="430" ry="340" fill="url(#light)"/><circle cx="1110" cy="160" r="47" fill="#fff" opacity=".75"/><g fill="#fff" opacity=".32"><path d="M100 180h105v-19h99v19h85v21H100z"/><path d="M790 90h70V74h155v16h80v23H790z"/><path d="M1170 310h85v-18h100v18h85v22h-270z"/></g><g fill="#a4bde9" opacity=".35"><path d="M0 450h100v-70h90v40h90v-110h100v60h110v-35h120v120h105v305H0z"/><path d="M770 760V450h100V320h100v65h150V275h100v120h120v45h100v320z"/></g>`;
function block(x, y, w, h, top, left, right) {
  const d = w * 0.42;
  artwork += `<path d="M${x} ${y}l${w} ${-d} ${w} ${d} ${-w} ${d}z" fill="${top}"/><path d="M${x} ${y}l${w} ${d}v${h}l${-w} ${-d}z" fill="${left}"/><path d="M${x + w} ${y + d}l${w} ${-d}v${h}l${-w} ${d}z" fill="${right}"/>`;
}
function island(x, y, size) {
  artwork += `<ellipse cx="${x + size}" cy="${y + size * 1.2}" rx="${size * 1.15}" ry="${size * 0.17}" fill="#628bc0" opacity=".1"/>`;
  block(x, y, size, size * 0.32, "#a6cbd1", "#829bc1", "#6e8cb7");
  block(
    x + size * 0.2,
    y + size * 0.4,
    size * 0.8,
    size * 0.28,
    "#a4bdd6",
    "#8a9dba",
    "#7087ae",
  );
  block(
    x + size * 0.5,
    y + size * 0.72,
    size * 0.5,
    size * 0.2,
    "#acbbd6",
    "#8e9bb9",
    "#7b86a9",
  );
  block(x, y - 13, size, 13, "#c9eee1", "#aad8ce", "#8abdc1");
}
function tree(x, y, s) {
  block(x - 5 * s, y - 45 * s, 6 * s, 49 * s, "#c7bcb7", "#8e8b9f", "#777f97");
  block(
    x - 36 * s,
    y - 85 * s,
    36 * s,
    35 * s,
    "#c9f0e5",
    "#9fcec9",
    "#85b7be",
  );
  block(
    x - 28 * s,
    y - 119 * s,
    28 * s,
    30 * s,
    "#d7f5e7",
    "#b6ddd5",
    "#99c8ce",
  );
  block(
    x - 17 * s,
    y - 146 * s,
    17 * s,
    23 * s,
    "#e2f8ee",
    "#c2e9db",
    "#a3cfd0",
  );
}
island(820, 400, 230);
tree(1000, 400, 1);
tree(1160, 410, 0.65);
island(305, 370, 110);
tree(410, 370, 0.48);
island(665, 205, 64);
tree(730, 205, 0.32);
island(1020, 675, 280);
tree(1205, 675, 1.4);
tree(1420, 690, 0.8);
island(-125, 675, 230);
tree(40, 675, 1.15);
tree(210, 700, 0.65);
artwork += `<g fill="#fff" opacity=".65"><rect x="705" y="450" width="8" height="8" rx="2"/><rect x="645" y="520" width="5" height="5" rx="1"/><rect x="788" y="315" width="6" height="6" rx="1"/><rect x="557" y="270" width="5" height="5" rx="1"/><rect x="1250" y="485" width="6" height="6" rx="1"/></g><rect y="530" width="1440" height="230" fill="url(#haze)"/></svg>`;
fs.mkdirSync(path.join(__dirname, "../public"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "../public/world-scene.svg"), artwork);
console.log("Generated original floating voxel islands.");
