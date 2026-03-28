/**
 * Собирает icon.ico для Windows (electron-builder ≥256px)
 */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const pngToIco = require('png-to-ico');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'app-icon-source.png');
const OUT = path.join(ROOT, 'icon.ico');

async function main() {
    if (!fs.existsSync(SRC)) {
        console.error('Missing source:', SRC);
        process.exit(1);
    }
    const base = await Jimp.read(SRC);
    const sizes = [256, 128, 48, 32, 16];
    const buffers = await Promise.all(
        sizes.map((s) => base.clone().resize(s, s).getBufferAsync(Jimp.MIME_PNG))
    );
    const ico = await pngToIco(buffers);
    fs.writeFileSync(OUT, ico);
    console.log('Wrote', OUT);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
