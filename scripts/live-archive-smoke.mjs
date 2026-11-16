// Non-mutating live scientific smoke tests against public NASA/IPAC IRSA services.
// This runs on an isolated QA branch, never on the submitted competition revision.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'production';
process.env.URUTAU_EMBEDDED = '1';

const { startServer } = require('../dist-server/server.cjs');
const report = { checkedAt: new Date().toISOString(), environment: 'GitHub Actions Ubuntu / Node 22', checks: [] };

function add(name, result, detail) {
  report.checks.push({ name, result, detail });
  console.log('[' + result + '] ' + name + ': ' + JSON.stringify(detail).slice(0, 1200));
}
async function jsonRequest(url, timeout = 60000) {
  const start = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = { raw: body.slice(0, 350) }; }
  return { status: res.status, ok: res.ok, elapsedMs: Date.now() - start, contentType, data: json };
}
async function guard(name, fn) {
  try {
    await fn();
  } catch (e) {
    add(name, 'FAIL', { error: e instanceof Error ? e.message : String(e) });
  }
}

const app = await startServer({ port: 0, host: '127.0.0.1', production: true, staticDir: path.resolve('dist'), dataDir: path.resolve('.qa-temp') });
try {
  await guard('Local API health and production assets', async () => {
    const resp = await jsonRequest(app.url + '/api/health', 12000);
    const html = await fetch(app.url + '/', {signal:AbortSignal.timeout(12000)});
    const text = await html.text();
    add('Local API health and production assets', resp.ok && resp.data.service === 'urutau-backend' && html.status === 200 && text.includes('<html') ? 'PASS' : 'FAIL', {apiHttp:resp.status,service:resp.data.service,siteHttp:html.status,htmlBytes:text.length});
  });

  let preset;
  await guard('QR3 metadata preset (NOT a live FITS test)', async () => {
    const res = await jsonRequest(app.url + '/api/spherex/verified-multislew', 15000);
    preset = res.data;
    const observations = preset?.observations ?? [];
    add('QR3 metadata preset (NOT a live FITS test)', res.ok && observations.length >= 2 && observations.every(x=>x.cutoutPath?.startsWith('qr3/level2/')) ? 'PASS' : 'FAIL', {http:res.status,count:observations.length,obs:observations.map(o=>({obsId:o.obsId,detector:o.detector,path:o.cutoutPath}))});
  });

  await guard('Actual NASA SPHEREx archive observations via TAP/SIA2', async () => {
    const res=await jsonRequest(app.url + '/api/spherex/observations?ra=337.8783221&dec=-5.1891588&radius=0.04', 115000);
    const obs=res.data?.observations ?? [];
    const valid=obs.filter(o=>o.cutoutPath?.startsWith('qr3/') || o.cutoutPath?.startsWith('dr1/'));
    add('Actual NASA SPHEREx archive observations via TAP/SIA2',res.ok && valid.length>0 ? 'PASS':'FAIL',{
      http:res.status,ms:res.elapsedMs,total:obs.length,validCutoutPaths:valid.length,
      first:obs.slice(0,4).map(o=>({obsId:o.obsId,release:o.release,detector:o.detector,dateObs:o.dateObs,cutoutPath:o.cutoutPath})),
      diagnostics:res.data?.diagnostics,upstreamError:res.data?.error
    });
  });

  if(preset?.observations?.length>=2) {
    for(let i=0;i<2;i++){
      const observation=preset.observations[i], name='Real SPHEREx QR3 FITS cutout '+(i+1);
      await guard(name,async()=>{
        const params=new URLSearchParams({path:observation.cutoutPath,ra:String(preset.ra),dec:String(preset.dec),size:'0.03'});
        const r=await jsonRequest(app.url + '/api/spherex/cutout?' + params, 165000);
        const d=r.data;
        const count=Array.isArray(d.image)?d.image.length:0;
        const valid=Array.isArray(d.image)?d.image.filter(v=>typeof v==='number'&&Number.isFinite(v)).length:0;
        const hasWcs=Boolean(d.wcs && Number.isFinite(Number(d.wcs.crval1)) && Number.isFinite(Number(d.wcs.crval2)));
        const realFits=Number(d.headersSummary?.FITS_BYTES)>2880 && Number(d.headersSummary?.HDU_COUNT)>=2;
        const ok=r.ok&&d.width>5&&d.height>5&&count===d.width*d.height&&valid>0&&hasWcs&&realFits;
        add(name,ok?'PASS':'FAIL',{
          http:r.status,ms:r.elapsedMs,obsId:observation.obsId,path:observation.cutoutPath,
          width:d.width,height:d.height,pixels:count,finitePixels:valid,wcs:hasWcs,
          wavelengthUm:d.targetWavelengthUm,fitsBytes:d.headersSummary?.FITS_BYTES,
          hduCount:d.headersSummary?.HDU_COUNT,dateObs:d.dateObs,
          error:d.error, errorType:d.errorType, irsaUrl:d.irsaUrl
        });
      });
    }
  }

  await guard('CDS/SIMBAD named astronomical object lookup',async()=>{
    const r=await jsonRequest(app.url + '/api/resolve-target?name='+encodeURIComponent("Barnard's Star"), 45000);
    add('CDS/SIMBAD named astronomical object lookup',r.ok&&Number.isFinite(r.data.ra)&&Number.isFinite(r.data.dec)?'PASS':'FAIL',{http:r.status,ms:r.elapsedMs,ra:r.data.ra,dec:r.data.dec,source:r.data.source,error:r.data.error});
  });

  await guard('Gaia DR3 comparison source lookup',async()=>{
    const r=await jsonRequest(app.url+'/api/gaia-dr3?ra=337.8783221&dec=-5.1891588&radius=0.05',65000);
    add('Gaia DR3 comparison source lookup',r.ok&&Array.isArray(r.data.sources)&&r.data.sources.length>0?'PASS':'FAIL',{http:r.status,ms:r.elapsedMs,count:r.data.sources?.length,source:r.data.mirrorUsed,error:r.data.error});
  });
} finally {
  await app.close();
  report.summary = {passed: report.checks.filter(c=>c.result==='PASS').length, failed:report.checks.filter(c=>c.result==='FAIL').length};
  await fs.mkdir('qa-results',{recursive:true});
  await fs.writeFile('qa-results/live-archive-smoke.json',JSON.stringify(report,null,2));
  console.log('=== FINAL QA ===',JSON.stringify(report.summary));
  if(report.summary.failed>0)process.exitCode=1;
}
