/* Study Tracker — calendar rendering (Grid and List views) and the monthly summary.
   Both views are built from the same StudyDates month data and the same per-day summaries,
   so switching views can never change or duplicate any saved data. */
(function () {
  'use strict';
  var ST = window.ST, h = ST.h, D = window.StudyDates, M = window.StudyModel;

  function ariaForDay(iso, info) {
    var p = D.parseISO(iso);
    var s = p.day + ' ' + D.MONTH_NAMES[p.month - 1] + ' ' + p.year;
    if (!info) return s + ', no notes';
    var bits = [];
    if (info.points) bits.push(info.points + (info.points === 1 ? ' learning point' : ' learning points'));
    if (info.review) bits.push('has personal review');
    if (info.status !== 'not_started') bits.push(M.STATUS_LABELS[info.status].toLowerCase());
    if (info.durationMin) bits.push(D.formatMinutes(info.durationMin));
    return s + (bits.length ? ', ' + bits.join(', ') : ', no notes');
  }

  /** A day "has notes" (is visually marked) when it has any saved record: points, review, status, time, tags or rating. */
  function hasRecord(info) { return !!info; }

  function dayClasses(base, iso, ctx, info) {
    var c = [base];
    if (iso === ctx.today) c.push('today');
    if (iso === ctx.selected) c.push('selected');
    if (hasRecord(info)) c.push('has-notes', 'status-' + info.status);
    else c.push('empty');
    return c.join(' ');
  }

  function renderGrid(container, ctx) {
    var grid = D.buildMonthGrid(ctx.year, ctx.month, ctx.weekStart);
    var head = h('div', { class: 'grid-head', role: 'row' },
      D.weekdayHeadings(ctx.weekStart).map(function (w) { return h('div', { role: 'columnheader', title: w.long }, w.short); }));

    var body = h('div', { class: 'grid-body', role: 'rowgroup' });
    body.style.gridTemplateRows = 'repeat(' + grid.weeks.length + ', minmax(64px, 1fr))';
    grid.weeks.forEach(function (week) {
      body.appendChild(h('div', { class: 'grid-row', role: 'row' }, week.map(function (cell) {
        if (!cell) return h('div', { class: 'blank', 'aria-hidden': 'true' }); // alignment only: never a date
        var info = ctx.days[cell.iso];
        var badges = [];
        if (info) {
          if (info.status === 'completed') badges.push(h('span', { class: 'badge-done', title: 'Completed' }, ST.svg(ST.ICON.check, 14)));
          if (info.review) badges.push(h('span', { class: 'badge-review', title: 'Has a personal review' }, ST.svg(ST.ICON.note, 13)));
          if (info.points) badges.push(h('span', { class: 'badge-count', title: info.points + (info.points === 1 ? ' learning point' : ' learning points') }, String(info.points)));
        }
        return h('button', {
          type: 'button', class: dayClasses('day', cell.iso, ctx, info), role: 'gridcell',
          dataset: { date: cell.iso, status: info ? info.status : 'none' },
          'aria-label': ariaForDay(cell.iso, info), 'aria-pressed': cell.iso === ctx.selected ? 'true' : 'false',
          'aria-current': cell.iso === ctx.today ? 'date' : null,
          onclick: function () { ctx.onSelect(cell.iso); }
        },
          h('span', { class: 'day-top' },
            h('span', { class: 'day-num' }, String(cell.day)),
            badges.length ? h('span', { class: 'day-badges' }, badges) : null),
          info && info.firstPoints.length ? h('span', { class: 'day-snippet' }, info.firstPoints.join(' · ')) : null,
          info && info.durationMin ? h('span', { class: 'day-time' }, D.formatMinutes(info.durationMin)) : null);
      })));
    });
    container.appendChild(h('div', { class: 'grid', role: 'grid', 'aria-label': D.MONTH_NAMES[ctx.month - 1] + ' ' + ctx.year }, head, body));
  }

  function renderList(container, ctx) {
    var list = h('div', { class: 'list', role: 'list', 'aria-label': D.MONTH_NAMES[ctx.month - 1] + ' ' + ctx.year });
    D.buildMonthList(ctx.year, ctx.month).forEach(function (d) {
      var info = ctx.days[d.iso];
      var lines = null;
      if (info && info.firstPoints.length) {
        var items = info.firstPoints.slice(0, 2).map(function (t) { return h('li', null, t); });
        if (info.points > 2) items.push(h('li', { class: 'more' }, '+' + (info.points - 2) + ' more'));
        lines = h('ul', { class: 'card-lines' }, items);
      } else if (info && info.review) lines = h('span', { class: 'card-none' }, 'Personal review only');
      else if (info) lines = h('span', { class: 'card-none' }, 'No learning points yet');
      else lines = h('span', { class: 'card-none' }, 'No notes');

      var meta = [];
      if (info && info.status !== 'not_started') meta.push(h('span', { class: 'status-chip ' + info.status }, M.STATUS_LABELS[info.status]));
      var row = [];
      if (info && info.durationMin) row.push(h('span', null, D.formatMinutes(info.durationMin)));
      if (info && info.review) row.push(h('span', { title: 'Has a personal review' }, ST.svg(ST.ICON.note, 14)));
      if (row.length) meta.push(h('span', { class: 'row' }, row));

      list.appendChild(h('button', {
        type: 'button', role: 'listitem', class: dayClasses('card', d.iso, ctx, info),
        dataset: { date: d.iso, status: info ? info.status : 'none' },
        'aria-label': ariaForDay(d.iso, info), 'aria-current': d.iso === ctx.today ? 'date' : null,
        onclick: function () { ctx.onSelect(d.iso); }
      },
        h('span', { class: 'card-date' }, h('span', { class: 'n' }, String(d.day)), h('span', { class: 'w' }, D.WEEKDAY_SHORT[d.weekday])),
        h('span', { class: 'card-body' }, lines),
        h('span', { class: 'card-meta' }, meta)));
    });
    container.appendChild(list);
    var focus = list.querySelector('.card.selected') || list.querySelector('.card.today');
    if (focus && ctx.scrollToFocus) { try { focus.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
  }

  /**
   * ctx: { view, year, month, weekStart, today, selected, days, onSelect, scrollToFocus }
   * Replaces the contents of `container`.
   */
  function renderCalendar(container, ctx) {
    var keepScroll = null;
    var oldList = container.querySelector('.list');
    if (oldList && ctx.view === 'list' && ctx.keepScroll) keepScroll = oldList.scrollTop;
    container.textContent = '';
    if (ctx.view === 'list') renderList(container, ctx); else renderGrid(container, ctx);
    if (keepScroll !== null) { var nl = container.querySelector('.list'); if (nl) nl.scrollTop = keepScroll; }
  }

  function renderSummary(container, stats, loading) {
    container.textContent = '';
    function chip(label, value) { return h('span', { class: 'chip' }, h('b', null, String(value)), label); }
    container.appendChild(chip('study days', stats.studyDays));
    container.appendChild(chip('completed', stats.completedDays));
    container.appendChild(chip('learning points', stats.learningPoints));
    container.appendChild(chip(stats.daysWithDuration ? 'studied' : 'time recorded', stats.daysWithDuration ? D.formatMinutes(stats.totalMinutes) : '—'));
    if (stats.reviewDays) container.appendChild(chip('with review', stats.reviewDays));
    container.classList.toggle('loading', !!loading);
  }

  ST.renderCalendar = renderCalendar;
  ST.renderSummary = renderSummary;
})();
