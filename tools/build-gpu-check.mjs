import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
const html=readFileSync('tests/browser.html','utf8').split('<script')[0];
const source=readFileSync('tests/generated/bvh.js','utf8')+'\n'+readFileSync('tests/generated/shaders.js','utf8')+'\n'+readFileSync('tests/generated/GpuTimer.js','utf8')+'\n'+readFileSync('tests/gpu-harness.js','utf8').replace(/^import .*;$/gm,'');
writeFileSync('GPU-CHECK.html',html+'<script type="module">\n'+source.replace(/^export /gm,'')+'\n</script></html>');

mkdirSync('public', {recursive:true});
writeFileSync('public/gpu-check.html', readFileSync('GPU-CHECK.html'));
