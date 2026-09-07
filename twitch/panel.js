/*
 * Kraken on Twitch — the panel.
 *
 * ONE FETCH DRAWS ALL FOUR TABS. /api/hunter/<name> answers the whole thing,
 * which matters here more than anywhere: this file runs once per viewer, and a
 * channel with three hundred of them would otherwise make twelve hundred
 * requests to fill one box.
 *
 * NO INLINE HANDLERS. Twitch serves extensions under script-src 'self', so an
 * onclick attribute is dropped without a word and the tabs become decoration.
 * Everything is addEventListener.
 *
 * NOTHING IS BUILT WITH innerHTML from data. A PSN id is a string somebody else
 * chose and this is a page on a stranger's channel; the DOM is assembled with
 * createElement and textContent so there is no path from a name to markup.
 *
 * IT COMPUTES NOTHING. Every number printed here arrives priced from the API,
 * which is itself printing what the bot stored. The only arithmetic in this
 * file is picking a colour band for the bar.
 */
(function () {
  'use strict';

  var API = 'https://platinumintel.co.uk/api/hunter/';
  var SITE = 'https://platinumintel.co.uk';

  /* Half the API's cache, so the panel is never showing something the edge has
     already replaced, and slow enough that a busy channel costs nothing. */
  var REFRESH_MS = 60000;

  var state = { psn: null, data: null, tab: 'now', timer: null };

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------ helpers -- */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function n(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x.toLocaleString('en-GB') : '0';
  }

  /* 1st, 2nd, 3rd, and the teens that break the rule. */
  function ordinal(v) {
    var x = Number(v);
    if (!Number.isFinite(x)) return '';
    var t = x % 100;
    if (t >= 11 && t <= 13) return 'th';
    return ['th', 'st', 'nd', 'rd'][x % 10] || 'th';
  }

  function rank(v) {
    var s = el('span');
    s.appendChild(document.createTextNode(n(v)));
    s.appendChild(el('sup', null, ordinal(v)));
    return s;
  }

  /*
   * The site's own bands, so a bar means the same thing on a stream as it does
   * on the website: bronze to 39, silver to 69, gold to 99, green at 100, and
   * platinum blue overriding all of it once the plat is in.
   */
  function band(pct, hasPlat) {
    if (hasPlat) return 'p';
    if (pct >= 100) return 'd';
    if (pct >= 70) return 'g';
    if (pct >= 40) return 's';
    return '';
  }

  /*
   * Art, with the tile behind it doing the work when the image cannot.
   *
   * PSN's image host has to be allowlisted in the developer console. If that is
   * ever missed, or a game simply has no icon, this leaves the gradient tile
   * rather than a broken-image glyph on somebody's channel.
   */
  function art(src, size) {
    if (!src) return el('span', 'art ' + size);
    var img = document.createElement('img');
    img.className = 'art ' + size;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', function () {
      var tile = el('span', 'art ' + size);
      if (img.parentNode) img.parentNode.replaceChild(tile, img);
    });
    img.src = src;
    return img;
  }

  function card(cls) { return el('div', 'card' + (cls ? ' ' + cls : '')); }

  function label(parent, text) { parent.appendChild(el('span', 'lbl', text)); return parent; }

  /* "in 2 days", "12 Mar" — near things get a countdown, far things get a date,
     because a countdown to March is not urgency, it is arithmetic. */
  function closeLabel(at) {
    var days = Math.ceil((Number(at) - Date.now()) / 86400000);
    if (!Number.isFinite(days)) return '';
    if (days <= 1) return 'tomorrow';
    if (days <= 21) return days + ' days';
    return new Date(Number(at)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function ago(at) {
    var mins = Math.floor((Date.now() - Number(at)) / 60000);
    if (!Number.isFinite(mins) || mins < 0) return '';
    if (mins < 60) return mins + 'm';
    var h = Math.floor(mins / 60);
    if (h < 24) return h + 'h ' + (mins % 60) + 'm';
    var d = Math.floor(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }

  var CUP = 'M6 2h12v6a6 6 0 0 1-12 0V2zM11 14h2v4h-2zM7 20h10v2H7z';

  function svgCup(cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', CUP);
    svg.appendChild(p);
    if (cls) svg.setAttribute('class', cls);
    return svg;
  }

  function linkBtn(text, href, go) {
    var a = el('a', 'btn' + (go ? ' go' : ''), text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  /* ------------------------------------------------------------- states -- */

  function showState(title, body, spinning) {
    var s = $('state');
    s.textContent = '';
    if (spinning) s.appendChild(el('span', 'spin'));
    if (title) s.appendChild(el('h2', null, title));
    if (body) s.appendChild(el('p', null, body));
    s.hidden = false;
    $('body').hidden = true;
    $('tabs').hidden = true;
  }

  /* ------------------------------------------------------------- tab: now - */

  function tabNow(d, out) {
    var g = d.playing;
    var live = d.live && d.live.on;

    if (g) {
      var c = card();
      var gameRow = el('div', 'game');
      gameRow.appendChild(art(g.icon, 'g44'));
      var t = el('span', 'gtxt');
      t.appendChild(el('span', 't', g.title));
      var meta = el('span', 'm');
      if (g.platform) meta.appendChild(el('span', 'chip', g.platform));
      meta.appendChild(document.createTextNode(
        (g.platform ? '  ' : '') + n(g.earned) + ' of ' + n(g.trophies) + ' trophies',
      ));
      t.appendChild(meta);
      gameRow.appendChild(t);
      c.appendChild(gameRow);

      var bar = el('div', 'bar ' + band(g.progress, false));
      var fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, Number(g.progress) || 0)) + '%';
      bar.appendChild(fill);
      c.appendChild(bar);

      var r = el('div', 'row');
      r.appendChild(el('span', 'pct', (Number(g.progress) || 0) + '% · ' + n(g.points) + ' / ' + n(g.max) + ' pts'));
      r.appendChild(el('span', 'pct', n(g.ownedHere) + ' of us own it'));
      c.appendChild(r);
      out.appendChild(c);
    }

    /*
     * The milestone, and it only ever appears when it is genuinely close - the
     * API refuses to send one otherwise. A panel that always has something to
     * say is a panel nobody reads.
     */
    if (d.milestone) {
      var m = el('div', 'miles');
      m.appendChild(svgCup());
      var mt = el('span');
      mt.appendChild(el('span', 'n', n(d.milestone.need) + (d.milestone.need === 1 ? ' trophy' : ' trophies')));
      var line = el('span', 't');
      line.appendChild(document.createTextNode('from their '));
      line.appendChild(el('b', null, n(d.milestone.at) + ordinal(d.milestone.at) + ' platinum'));
      mt.appendChild(line);
      m.appendChild(mt);
      out.appendChild(m);
    }

    if (live) {
      var tn = card('tonight');
      var tr = el('div', 'row');
      label(tr, 'Tonight, on stream');
      tr.appendChild(el('span', 'v', ago(d.live.since)));
      tn.appendChild(tr);
      tn.appendChild(el('div', 'muted', 'Live now' + (d.live.viewers != null ? ' · ' + n(d.live.viewers) + ' watching' : '')));
      out.appendChild(tn);
    } else if (d.closing && d.closing.length) {
      /*
       * OFF AIR IS WHERE THE DEADLINES GO. Most people who ever see this panel
       * arrive when nobody is streaming, and "three games in your library die
       * this month" is the most useful thing this project knows. Mid-stream it
       * would be a distraction from what they are actually doing, so the live
       * branch above takes that space instead.
       */
      var w = card('warn');
      label(w, 'Closing soon, and they own them');
      d.closing.forEach(function (cg, i) {
        var row = el('div', 'cl' + (i === 0 ? ' first' : ''));
        row.appendChild(art(cg.icon, 'g26'));
        var tx = el('span', 'txt');
        tx.appendChild(el('span', 't', cg.title));
        tx.appendChild(el('span', 'm', n(cg.left) + ' left · ' + n(cg.points) + ' pts'));
        row.appendChild(tx);
        var when = closeLabel(cg.closesAt);
        row.appendChild(el('span', 'd' + (/[A-Z]/.test(when) ? ' later' : ''), when));
        w.appendChild(row);
      });
      out.appendChild(w);
    }

    if (!live && d.live && d.live.lastStream && d.live.lastStream.end) {
      var ls = card();
      var lr = el('div', 'row');
      label(lr, 'Last stream');
      lr.appendChild(el('span', 'pct', ago(d.live.lastStream.end)));
      ls.appendChild(lr);
      out.appendChild(ls);
    }

    if (d.chase) {
      var b = card();
      label(b, 'On the board');
      var ch = el('div', 'chase');
      var rk = el('span', 'rk');
      rk.appendChild(rank(d.hunter.rank));
      ch.appendChild(rk);
      var to = el('span', 'to' + (d.chase.past ? ' past' : ''));
      if (d.chase.past) {
        to.appendChild(el('b', null, 'past'));
        to.appendChild(document.createTextNode(' ' + n(d.chase.rank) + ordinal(d.chase.rank)));
      } else {
        to.appendChild(el('b', null, n(d.chase.gap)));
        to.appendChild(document.createTextNode(' to ' + n(d.chase.rank) + ordinal(d.chase.rank)));
      }
      ch.appendChild(to);
      b.appendChild(ch);
      out.appendChild(b);
    }

    var f = el('div', 'foot');
    f.appendChild(linkBtn('Full profile ›', SITE + '/hunter/' + encodeURIComponent(d.hunter.name)));
    out.appendChild(f);
  }

  /* ------------------------------------------------------------ tab: list - */

  function tabList(d, out) {
    var head = el('div', 'row');
    label(head, 'What they will play next');
    head.appendChild(el('span', 'lbl', n(d.list.length) + (d.list.length === 1 ? ' game' : ' games')));
    out.appendChild(head);

    if (!d.list.length) {
      var empty = card();
      empty.appendChild(el('p', 'muted',
        'Nothing lined up yet. This fills in when they add games to their list in Discord.'));
      empty.style.margin = '0';
      out.appendChild(empty);
    } else {
      var c = card();
      c.style.padding = '8px 11px';
      d.list.forEach(function (g, i) {
        var row = el('div', 'li' + (i === 0 ? ' first' : ''));
        row.appendChild(art(g.icon, 'g32'));
        var tx = el('span', 'txt');
        tx.appendChild(el('span', 't', g.title));
        var m = el('span', 'm');
        m.appendChild(el('b', null, n(g.points) + ' pts'));
        m.appendChild(document.createTextNode(
          ' · ' + n(g.ownedHere) + ' of us own it' +
          (g.finishedHere ? ', ' + n(g.finishedHere) + ' finished' : ''),
        ));
        tx.appendChild(m);
        row.appendChild(tx);
        c.appendChild(row);
      });
      out.appendChild(c);
    }

    var f = el('div', 'foot');
    f.appendChild(el('p', 'fine', 'Points are what a full completion pays on this board.'));
    out.appendChild(f);
  }

  /* ---------------------------------------------------------- tab: hunter - */

  function tabHunter(d, out) {
    var h = d.hunter;

    var top = card();
    var who = el('div', 'who');
    if (h.avatar) {
      var av = document.createElement('img');
      av.className = 'av';
      av.alt = '';
      av.addEventListener('error', function () {
        if (av.parentNode) av.parentNode.replaceChild(el('span', 'av'), av);
      });
      av.src = h.avatar;
      who.appendChild(av);
    } else {
      who.appendChild(el('span', 'av'));
    }
    var wt = el('span');
    wt.style.minWidth = '0';
    wt.appendChild(el('span', 'n', h.name));
    var r = el('span', 'r');
    r.appendChild(document.createTextNode(n(h.rank) + ordinal(h.rank) + ' of ' + n(h.of) + ' · '));
    r.appendChild(document.createTextNode(n(h.points) + ' pts'));
    wt.appendChild(r);
    who.appendChild(wt);
    top.appendChild(who);
    out.appendChild(top);

    var duo = el('div', 'duo');
    var c1 = card();
    label(c1, 'Completion');
    var v1 = el('div', 'big', (Number(h.completion) || 0).toFixed(1));
    v1.appendChild(el('small', null, '%'));
    c1.appendChild(v1);
    var c2 = card();
    label(c2, 'Games 100%');
    var v2 = el('div', 'big', n(h.games.completed));
    v2.appendChild(el('small', null, '/ ' + n(h.games.started)));
    c2.appendChild(v2);
    duo.appendChild(c1);
    duo.appendChild(c2);
    out.appendChild(duo);

    var cab = card();
    label(cab, 'Cabinet');
    var cabRow = el('div', 'cab');
    [['p', h.cabinet.platinum], ['g', h.cabinet.gold],
     ['s', h.cabinet.silver], ['b', h.cabinet.bronze]].forEach(function (pair) {
      var cup = el('span', 'cup ' + pair[0]);
      cup.appendChild(svgCup());
      cup.appendChild(document.createTextNode(n(pair[1])));
      cabRow.appendChild(cup);
    });
    cab.appendChild(cabRow);
    out.appendChild(cab);

    if (h.rarest) {
      var rc = card();
      label(rc, 'Rarest they have ever earned');
      var rr = el('div', 'rare');
      rr.appendChild(el('span', 'rate', Number(h.rarest.rate).toFixed(2) + '%'));
      var rt = el('span');
      rt.style.minWidth = '0';
      rt.appendChild(el('span', 't', h.rarest.name));
      if (h.rarest.game) rt.appendChild(el('span', 'm', h.rarest.game));
      rr.appendChild(rt);
      rc.appendChild(rr);
      out.appendChild(rc);
    }

    var f = el('div', 'foot');
    f.appendChild(linkBtn('Full profile ›', SITE + '/hunter/' + encodeURIComponent(h.name)));
    if (h.updatedAt) f.appendChild(el('p', 'fine', 'Last scanned ' + ago(h.updatedAt)));
    out.appendChild(f);
  }

  /* ----------------------------------------------------------- tab: board - */

  function tabBoard(d, out) {
    var c = card();
    var seen = {};
    var first = true;

    function addRow(row, mine) {
      if (seen[row.rank]) return;
      seen[row.rank] = true;
      var e = el('div', 'br' + (mine ? ' me' : '') + (first && !mine ? ' first' : ''));
      first = false;
      e.appendChild(el('span', 'pos', n(row.rank) + ordinal(row.rank)));
      e.appendChild(el('span', 'nm', row.name));
      e.appendChild(el('span', 'pt', n(row.points)));
      c.appendChild(e);
    }

    d.board.top.forEach(function (row) { addRow(row, row.rank === d.hunter.rank); });

    /* The gap is drawn only when there is one. Five rows and a row at sixth
       with three dots between them would be lying about a distance. */
    var lastTop = d.board.top.length ? d.board.top[d.board.top.length - 1].rank : 0;
    var nextUp = d.board.around.length ? d.board.around[0].rank : 0;
    if (nextUp > lastTop + 1) c.appendChild(el('div', 'gapdot', '· · ·'));

    d.board.around.forEach(function (row) { addRow(row, row.rank === d.hunter.rank); });
    out.appendChild(c);

    /*
     * THIS TAB IS THE ONLY ONE WRITTEN FOR A STRANGER. Most people who open it
     * have never heard of the place, so the space under the board goes to what
     * it is rather than to another number.
     */
    var pitch = card();
    label(pitch, 'What this is');
    pitch.appendChild(el('p', 'muted',
      'A PlayStation trophy board where rarity decides the points, not the metal. '
      + n(d.hunter.of) + ' hunters, every trophy scanned rather than typed in.'));
    out.appendChild(pitch);

    var f = el('div', 'foot');
    f.appendChild(linkBtn('Join Platinum Intel', SITE, true));
    f.appendChild(linkBtn('See the whole board ›', SITE + '/leaderboard'));
    out.appendChild(f);
  }

  /* ------------------------------------------------------------- render -- */

  var TABS = { now: tabNow, list: tabList, hunter: tabHunter, board: tabBoard };

  function render() {
    var d = state.data;
    if (!d) return;

    $('state').hidden = true;
    $('tabs').hidden = false;
    var out = $('body');
    out.hidden = false;
    out.textContent = '';
    out.scrollTop = 0;

    (TABS[state.tab] || tabNow)(d, out);

    var st = $('status');
    st.textContent = d.live && d.live.on ? '● Live' : d.hunter.name;
    st.className = 'sub' + (d.live && d.live.on ? ' on' : '');

    Array.prototype.forEach.call($('tabs').children, function (b) {
      var on = b.getAttribute('data-tab') === state.tab;
      b.className = on ? 'on' : '';
      b.setAttribute('aria-current', on ? 'true' : 'false');
    });
  }

  /* --------------------------------------------------------------- load -- */

  function load() {
    if (!state.psn) return;
    fetch(API + encodeURIComponent(state.psn), { method: 'GET' })
      .then(function (res) {
        if (res.status === 404) throw new Error('unknown');
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (data) {
        state.data = data;
        render();
      })
      .catch(function (err) {
        /* A panel that has already drawn keeps what it has. Replacing a working
           board with an error because one refresh timed out is worse than being
           thirty seconds stale. */
        if (state.data) return;
        if (String(err.message) === 'unknown') {
          showState('Not on the board',
            '“' + state.psn + '” is not a registered hunter. The broadcaster can fix the '
            + 'name in the extension settings.');
        } else {
          showState('Cannot reach the board', 'It will try again in a minute.');
        }
      });
  }

  /* ---------------------------------------------------------------- go --- */

  function start(psn) {
    state.psn = psn;
    load();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(load, REFRESH_MS);
  }

  function readConfig() {
    var seg = window.Twitch && window.Twitch.ext
      && window.Twitch.ext.configuration && window.Twitch.ext.configuration.broadcaster;
    if (!seg || !seg.content) return null;
    try {
      var parsed = JSON.parse(seg.content);
      return parsed && typeof parsed.psn === 'string' && parsed.psn ? parsed.psn : null;
    } catch (e) {
      return null;
    }
  }

  function unconfigured() {
    showState('Not set up yet',
      'The broadcaster needs to add their PSN ID in this extension’s settings.');
  }

  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call($('tabs').children, function (b) {
      b.addEventListener('click', function () {
        state.tab = b.getAttribute('data-tab');
        render();
      });
    });

    if (!window.Twitch || !window.Twitch.ext) {
      /* Opened outside Twitch — local test, or a curious person with the URL. */
      showState('Needs Twitch', 'This panel only runs inside a Twitch channel.');
      return;
    }

    var psn = readConfig();
    if (psn) start(psn);

    /* The configuration may arrive after the helper does, and it changes when
       the broadcaster saves a new name without reloading anybody's page. */
    window.Twitch.ext.configuration.onChanged(function () {
      var next = readConfig();
      if (!next) { unconfigured(); return; }
      if (next !== state.psn) { state.data = null; start(next); }
    });

    window.Twitch.ext.onAuthorized(function () {
      if (!state.psn && !readConfig()) unconfigured();
    });
  });
})();
