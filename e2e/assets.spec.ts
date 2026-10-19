import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { capture } from './capture';

const read=(page:Page)=>page.evaluate(()=>window.__FRACTURED_DIAGNOSTICS__!.read());
/** Fraction of bytes that differ between two same-size PNG screenshots' raw pixels. */
async function pixelChange(page:Page,a:Buffer,b:Buffer):Promise<number> {
  return page.evaluate(async([x,y])=>{
    const load=async(b64:string)=>{const img=new Image();img.src=`data:image/png;base64,${b64}`;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const g=c.getContext('2d')!;g.drawImage(img,0,0);return g.getImageData(0,0,c.width,c.height).data;};
    const [p,q]=await Promise.all([load(x),load(y)]);let changed=0;
    for(let i=0;i<p.length;i+=4)if(Math.abs(p[i]!-q[i]!)+Math.abs(p[i+1]!-q[i+1]!)+Math.abs(p[i+2]!-q[i+2]!)>24)changed++;
    return changed/(p.length/4);
  },[a.toString('base64'),b.toString('base64')] as const);
}

test('loads every physical asset, frames the swarm at true scale, and freezes all motion on pause',async({page})=>{
  test.setTimeout(120_000);
  const errors:string[]=[];const failed:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('response',r=>{if(r.status()>=400)failed.push(`${r.status()} ${r.url()}`);});

  await page.goto('/?hud=0');
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  const loaded=await read(page);
  expect(loaded.render.assetsTotal).toBeGreaterThan(20);
  expect(loaded.render.assetsReady).toBe(loaded.render.assetsTotal);
  expect(loaded.render.assetsFailed).toBe(0);
  const assets=loaded.render.assets;
  expect(assets.debrisInstances).toBeGreaterThan(50);
  expect(assets.layout!.formations.length).toBeGreaterThanOrEqual(8);
  expect(assets.layout!.clusters).toContain('landmark');

  // Swarm close-up: the nearest microbots use the full approved model.
  await page.keyboard.press('Shift+Digit1');await page.waitForTimeout(800);
  const close=await read(page);
  expect(close.render.assets.microbotsVisible[0]).toBeGreaterThan(0);
  await capture(page,'assets-swarm-closeup.png');

  // Running: the formation turns on model time, so the frame changes.
  const r0=await page.screenshot();await page.waitForTimeout(1200);const r1=await page.screenshot();
  expect(await pixelChange(page,r0,r1)).toBeGreaterThan(0.002);

  // Paused: microbots, debris drift, gas and shears all stop with the clock.
  await page.goto('/?hud=1');
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  await page.getByTestId('play-pause').click();
  await page.evaluate(()=>(document.activeElement instanceof HTMLElement)&&document.activeElement.blur());
  await page.keyboard.press('KeyH');
  await page.keyboard.press('Shift+Digit1');await page.waitForTimeout(800);
  const frozen=await read(page);
  const p0=await page.screenshot();await page.waitForTimeout(1200);const p1=await page.screenshot();
  expect((await read(page)).time).toBe(frozen.time);
  expect(await pixelChange(page,p0,p1)).toBeLessThan(0.0005);

  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
});

test('quality presets change microbot counts and LODs, never the layout',async({page})=>{
  test.setTimeout(120_000);
  await page.goto('/?quality=balanced');
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  const balanced=await read(page);
  await page.getByTestId('quality-performance').click();
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  await page.waitForTimeout(500);
  const performance=await read(page);
  expect(performance.render.assets.layout).toEqual(balanced.render.assets.layout);
  expect(performance.render.assets.debrisInstances).toBe(balanced.render.assets.debrisInstances);
});
