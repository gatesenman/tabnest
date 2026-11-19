// Renders build/icon.svg into every icon size the app and installers need.
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const render = (svgFile, size) => new Resvg(readFileSync(svgFile), { fitTo: { mode: 'width', value: size } }).render().asPng()
mkdirSync('build/icons', { recursive: true })
writeFileSync('build/icon.png', render('build/icon.svg', 1024))
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) writeFileSync(`build/icons/${s}x${s}.png`, render('build/icon.svg', s))
writeFileSync('build/icon.ico', await pngToIco([16, 24, 32, 48, 64, 128, 256].map((s) => `build/icons/${s}x${s}.png`)))
writeFileSync('resources/icon.png', render('build/icon.svg', 512))
writeFileSync('resources/tray.png', render('build/tray.svg', 32))
writeFileSync('resources/tray@2x.png', render('build/tray.svg', 64))
console.log('icons generated')
