/**
 * The FAQ. GET /faq
 *
 * ONE SOURCE, TWO SURFACES. This imports `shared/faq.mjs` — the same module the
 * bot answers `/faq` from — rather than keeping a second copy of the text. Every
 * other shared thing on this site (tiers, the closing clock, supporter steps) is
 * mirrored because it is a dozen lines and mirroring is cheaper than the build
 * config. A FAQ is not a dozen lines. Two copies of a thousand words of prose
 * would disagree within a month, and the half nobody reread would be the wrong
 * half.
 *
 * REACHING OUTSIDE functions/ IS SAFE TO TRY, and that is worth saying because
 * the comment in _lib/page.js warns against it. If Cloudflare's bundler cannot
 * resolve this import, the BUILD fails — and a failed build deploys nothing, so
 * Pages carries on serving the last good version. That is a completely
 * different risk from a bad query, which deploys happily and takes the site down
 * at request time. Worst case here is a red tick and a one-line revert.
 *
 * NO DATABASE. This page reads nothing and can be cached hard: the text only
 * changes when somebody edits the file and pushes.
 */

import { FAQ, faqSection } from '../shared/faq.mjs';
import { page, html, esc, crumb } from './_lib/page.js';

/**
 * Discord's markdown, rendered as HTML.
 *
 * Deliberately NOT a markdown library. The input is not arbitrary markdown, it
 * is one file in this repo written by us, using six constructs. A parser would
 * be forty kilobytes to handle a syntax nobody is going to type into it.
 *
 * ESCAPED FIRST, ALWAYS. The source is trusted today, but "trusted input" is a
 * property of a file that anybody can edit, and the escaping costs nothing.
 * Everything below builds tags from the escaped text, never around raw input.
 */
function render(md) {
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      // Italics AFTER bold, so the doubled markers are already gone and a lone
      // asterisk can only mean emphasis. The other order turns **bold** into
      // <em>*bold*</em>.
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      // A bare channel id has no meaning outside Discord.
      .replace(/&lt;#\d+&gt;/g, 'the board channel')
      // Bare domains in the text, made clickable. Http only, no javascript:.
      .replace(
        /\b([a-z0-9-]+\.(?:pages\.dev|dev|com))\b(?![^<]*>)/g,
        '<a href="https://$1" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  const chunks = [];
  // Fenced blocks are pulled out whole: the scoring table is pre-formatted and
  // must keep its spacing, which is the one thing paragraph-wrapping destroys.
  for (const chunk of md.split(/```/)) {
    if (chunks.length % 2 === 1) {
      chunks.push(`<pre>${esc(chunk.trim())}</pre>`);
      continue;
    }
    const rendered = chunk
      .split(/\n{2,}/)
      .map((block) => {
        const lines = block.split('\n').filter((l) => l.trim());
        if (!lines.length) return '';
        if (lines[0].startsWith('## ')) {
          return `<h2>${inline(lines[0].slice(3))}</h2>${
            lines.length > 1 ? `<p>${lines.slice(1).map(inline).join('<br>')}</p>` : ''
          }`;
        }

        /*
         * A BLOCK IS NOT ALL ONE THING, which is what the first version assumed.
         *
         * It checked whether the block's FIRST line was a bullet and treated the
         * whole block accordingly — and in the source the bullets sit directly
         * under their heading line with no blank line between, like this:
         *
         *   **They went DOWN.**
         *   ▫️ Somebody finished a game you both own
         *   ▫️ You started a new game
         *
         * so the block began with bold text and every bullet in the FAQ came out
         * as a run-on paragraph. Walk the lines instead and close the list when
         * the bullets stop.
         */
        const out = [];
        let list = [];
        const flush = () => {
          if (!list.length) return;
          out.push(
            `<ul class="faqlist">${list.map((l) => `<li>${l}</li>`).join('')}</ul>`,
          );
          list = [];
        };

        let para = [];
        let small = false;
        const flushPara = () => {
          if (!para.length) return;
          out.push(`<p${small ? ' class="fine"' : ''}>${para.join('<br>')}</p>`);
          para = [];
          small = false;
        };

        for (const line of lines) {
          if (line.startsWith('▫️')) {
            flushPara();
            list.push(inline(line.replace(/^▫️\s*/, '')));
            continue;
          }
          flush();
          // "-#" is Discord's small text, and only ever starts a line.
          if (line.startsWith('-#')) {
            flushPara();
            small = true;
          }
          para.push(inline(line.replace(/^-#\s*/, '')));
        }
        flush();
        flushPara();
        return out.join('');
      })
      .join('');
    chunks.push(rendered);
  }
  return chunks.join('');
}

export async function onRequestGet() {
  const body = `
    ${crumb('/', 'Home')}

    <section class="hero">
      <h1>Questions</h1>
      <p class="sub">How the board works, in full</p>
    </section>

    ${FAQ.map(
      (f) => `<details class="faq"${f.value === 'joining' ? ' open' : ''}>
        <summary class="faqhead">
          <span class="caret" aria-hidden="true">&#9654;</span>
          <span class="fq">${esc(f.label)}</span>
          <span class="fd">${esc(f.description)}</span>
        </summary>
        <div class="faqbody">${render(
          // The section's own "## Getting on the board" is dropped: the summary
          // above it already says that, and a folder whose first line repeats
          // its own label reads like a rendering bug.
          faqSection(f.value, {}).replace(/^##[^\n]*\n+/, ''),
        )}</div>
      </details>`,
    ).join('')}

    <footer>
      Still stuck? Ask in Discord — somebody will know, and if they do not, it is
      probably a bug worth hearing about.
    </footer>`;

  return html(
    page({
      title: 'Questions · Kraken',
      description:
        'How Kraken scores PlayStation trophies: rarity, your completion percentage, ' +
        'and how the rest of the server changes what your games are worth.',
      here: 'faq',
      body,
    }),
    // An hour. Nothing here is live data — it changes when somebody edits the
    // file, which is a deploy, which busts the cache anyway.
    { maxAge: 3600 },
  );
}
