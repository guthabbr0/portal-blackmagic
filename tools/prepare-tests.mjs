import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('tests/generated',{recursive:true});
execFileSync(process.platform==='win32'?'tsc.cmd':'tsc',[
 'src/rendering/bvh.ts','src/rendering/shaders.ts','src/rendering/GpuTimer.ts','--target','ES2020','--module','ES2020',
 '--outDir','tests/generated','--skipLibCheck','--strict','--lib','ES2020,DOM'
],{stdio:'inherit'});
console.log('Open tests/browser.html through a local HTTP server to exercise the actual GPU shaders.');
