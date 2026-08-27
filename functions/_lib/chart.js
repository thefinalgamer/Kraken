/**
 * The points-over-time chart. One series, drawn as SVG by hand.
 *
 * NO CHART LIBRARY. Chart.js is 200KB to draw one line, it would be the only
 * dependency on the site, and a Pages Function that renders server-side cannot
 * use it without shipping a client bundle and a second render pass. The whole
 * page is currently a few kilobytes and paints in one go; that is worth more
 * than the features of a library we would use one percent of.
 *
 * FORM: single-series area. The reader's job here is "what shape has my score
 * been", which is trend-over-time, and with one series there is no identity to
 * encode — so one hue, a 2px line, and a 10% wash underneath it. No legend: a
 * legend with one swatch only restates the heading.
 *
 * The hue is the Kraken teal the rest of the site uses. Checked against the
 * panel surface rather than assumed — it clears 3:1, which is the bar that
 * applies to a lone series. (The categorical lightness band does not apply
 * here; there are no adjacent hues to separate.)
 *
 * LABELLED SPARINGLY, on purpose. The endpoint carries a value and the extremes
 * carry the axis; every other number lives in the tooltip and the table below.
 * A value on every point is chaos and goes unread.
 */

import { esc, n } from './page.js';

const PAD = { top: 18, right: 62, bottom: 26, left: 8 };
const W = 720;
const H = 190;

/** Clean axis numbers — 0 / 50,000 / 100,000, never 0 / 47,312 / 94,624. */
function niceStep(span, target = 3) {
  if (span <= 0) return 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= mag * m) return mag * m;
  }
  return mag * 10;
}

const shortDate = (ms) =>
  new Date(Number(ms)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * @param {{t:number, v:number}[]} points  oldest first
 */
export function pointsChart(points) {
  if (!Array.isArray(points) || points.length < 2) return '';

  const vs = points.map((p) => Number(p.v) || 0);
  const ts = points.map((p) => Number(p.t) || 0);

  /**
   * The y-axis does NOT start at zero, and that is correct for this chart.
   *
   * A zero baseline is compulsory for bars, where the length of the mark IS the
   * value and truncating it lies about the ratio. A line encodes change through
   * its slope, not its length — and a score that opens at 142,000 and moves by
   * a few thousand would spend three quarters of the plot as empty space with
   * every real movement flattened into a straight line at the top. That is a
   * chart that hides its own subject.
   *
   * Padded 12% either side so the line never touches the frame.
   */
  const rawLo = Math.min(...vs);
  const rawHi = Math.max(...vs);
  const spread = rawHi - rawLo || Math.max(1, Math.abs(rawHi) * 0.02);
  const step = niceStep(spread * 1.24);
  const vMin = Math.floor((rawLo - spread * 0.12) / step) * step;
  const top = Math.ceil((rawHi + spread * 0.12) / step) * step;

  const tMin = ts[0];
  const tMax = ts[ts.length - 1];
  const tSpan = Math.max(1, tMax - tMin);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (t) => PAD.left + ((Number(t) - tMin) / tSpan) * plotW;
  const y = (v) => PAD.top + plotH - ((Number(v) - vMin) / (top - vMin)) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(tMax).toFixed(1)},${(PAD.top + plotH).toFixed(1)}L${x(tMin).toFixed(1)},${(
    PAD.top + plotH
  ).toFixed(1)}Z`;

  // Gridlines: hairline, solid, one step off the surface. Recessive by design —
  // they carry the values that are not directly labelled and nothing more.
  const grid = [];
  for (let v = vMin; v <= top + step / 2; v += step) {
    const gy = y(v).toFixed(1);
    grid.push(
      `<line class="gl" x1="${PAD.left}" y1="${gy}" x2="${PAD.left + plotW}" y2="${gy}"/>` +
        `<text class="gt" x="${PAD.left + plotW + 8}" y="${gy}" dy="3.5">${n(Math.round(v))}</text>`,
    );
  }

  const last = points[points.length - 1];
  const lx = x(last.t);
  const ly = y(last.v);

  return `
<figure class="chart">
  <figcaption>Points over time</figcaption>
  <svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
       aria-label="Points over time, ending at ${n(last.v)}"
       data-points="${esc(JSON.stringify(points.map((p) => [p.t, Math.round(p.v)])))}"
       data-geom="${esc(JSON.stringify({ W, H, PAD, tMin, tSpan, vMin, top, plotW, plotH }))}">
    ${grid.join('')}
    <path class="wash" d="${area}"/>
    <path class="ln" d="${line}" vector-effect="non-scaling-stroke"/>
    <circle class="end" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5"/>
    <line class="cross" x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + plotH}" style="display:none"/>
    <circle class="hit" r="4.5" style="display:none"/>
    <text class="xt" x="${PAD.left}" y="${H - 8}">${shortDate(tMin)}</text>
    <text class="xt end-x" x="${(PAD.left + plotW).toFixed(1)}" y="${H - 8}">${shortDate(tMax)}</text>
  </svg>
  <div class="tip" hidden><b></b><span></span></div>
</figure>`;
}

/**
 * Crosshair and tooltip.
 *
 * The reader aims at a date, never at a 2px line, so the pointer's x is mapped
 * back through the same geometry the server used and snapped to the nearest
 * point. Values go in with textContent — the numbers are ours, but the habit is
 * the thing, and this file will eventually show a game title.
 */
export const CHART_JS = `
(function(){
  var fig=document.querySelector('.chart'); if(!fig) return;
  var svg=fig.querySelector('svg'), tip=fig.querySelector('.tip');
  var cross=svg.querySelector('.cross'), hit=svg.querySelector('.hit');
  var pts, g;
  try{ pts=JSON.parse(svg.dataset.points); g=JSON.parse(svg.dataset.geom); }catch(e){ return; }
  if(!pts||pts.length<2) return;
  var fmt=new Intl.NumberFormat('en-GB');
  var day={day:'numeric',month:'short',year:'numeric'};

  function px(t){ return g.PAD.left + ((t-g.tMin)/g.tSpan)*g.plotW; }
  function py(v){ return g.PAD.top + g.plotH - ((v-g.vMin)/(g.top-g.vMin))*g.plotH; }

  function show(ev){
    var r=svg.getBoundingClientRect();
    var vx=((ev.clientX-r.left)/r.width)*g.W;
    var best=0, bd=Infinity;
    for(var i=0;i<pts.length;i++){ var d=Math.abs(px(pts[i][0])-vx); if(d<bd){bd=d;best=i;} }
    var p=pts[best], cx=px(p[0]), cy=py(p[1]);
    cross.setAttribute('x1',cx); cross.setAttribute('x2',cx); cross.style.display='';
    hit.setAttribute('cx',cx); hit.setAttribute('cy',cy); hit.style.display='';
    tip.hidden=false;
    tip.querySelector('b').textContent=fmt.format(p[1])+' points';
    tip.querySelector('span').textContent=new Date(p[0]).toLocaleDateString('en-GB',day);
    var left=(cx/g.W)*r.width;
    tip.style.left=Math.max(0,Math.min(r.width-tip.offsetWidth,left-tip.offsetWidth/2))+'px';
  }
  function hide(){ cross.style.display='none'; hit.style.display='none'; tip.hidden=true; }

  svg.addEventListener('pointermove',show);
  svg.addEventListener('pointerleave',hide);
})();`;
