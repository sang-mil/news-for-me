# News for Me UI system

## Visual direction

**Editorial intelligence desk**: a calm, readable personal newsroom that feels closer to a focused publication workspace than a generic SaaS admin panel. Content hierarchy comes before decoration. The product's own topic and article data is the primary visual subject.

## Design tokens

| Token | Value | Purpose |
| --- | --- | --- |
| Ink | `#1c2b24` | Primary text and headings |
| Muted | `#6f7d74` | Supporting text and metadata |
| Canvas | `#f4f7f4` | App background |
| Surface | `#ffffff` | Main content surfaces |
| Accent | `#28634d` | Primary actions and selected emphasis |
| Forest | `#18372b` | High-priority actions and summary panel |
| Accent soft | `#eaf2ec` | Subtle emphasis and status background |
| Border | `#e3e9e4` | Structural separation |

Typography uses Pretendard for Korean UI, DM Sans for compact numeric/Latin labels, and Newsreader only as a restrained editorial accent. Spacing follows a 4/8px rhythm; controls use 8–12px corner radii and content surfaces use 14–20px.

## Screen hierarchy

1. **Newsroom** — compact editorial introduction and live counts, then topic list and topic creation form. The list is one continuous surface with separators, not a pile of cards.
2. **Personal archive** — saved stories first, annotation and tag controls beside each story on desktop and below it on mobile.
3. **Email briefing** — recipient, preview/send actions, schedule controls, schedule state, and email preview remain clearly grouped.
4. **Integrations** — AI providers and content sources are grouped separately. Connection, error, disabled, save, and test states remain visible.

## Responsive behavior

- Wide desktop: two-column newsroom; sticky topic form; archive articles use reading/content and annotation columns.
- Tablet: newsroom becomes a single column with topics before the form; archive controls become a stacked grid.
- Mobile: compact horizontally scrollable navigation; topic actions become a two-column button grid; forms and annotation controls stack in reading order.
- All layouts allow long Korean titles, email addresses, and URLs to wrap without forcing horizontal page overflow.

## Interaction and state coverage

- Visible focus rings for links, buttons, inputs, selects, and textareas.
- Hover and pressed states use short color/border transitions, not layout movement.
- Disabled and busy controls retain a clear reduced-opacity state and do not imply interactivity.
- Existing loading spinners, empty states, success/error feedback, collection diagnostics, schedule statuses, and integration statuses keep their semantic meaning.
- `prefers-reduced-motion: reduce` disables nonessential transitions and animation.

## Implementation notes

The refresh is a separate stylesheet imported after existing app styles. It does not alter API calls, persistence, auth, newsletter scheduling, or collection behavior. Keep new UI work in the dedicated stylesheet until a future component-level refactor is justified.

## Verification checklist

- [ ] Desktop: topic list and form, archive editor columns, newsletter controls, integration grid.
- [ ] Tablet: topic list remains before the form; no compressed action column.
- [ ] Mobile: nav can scroll horizontally; topic actions and archive editor stack; no horizontal overflow.
- [ ] States: signed out, loading, empty topics, collection in progress/error, saved article, empty archive, newsletter preview/error/scheduled, integration connected/error/disabled.
- [ ] Keyboard: tab through nav, topic actions, forms, archive actions, newsletter controls, and integration actions; visible focus throughout.
- [ ] Reduced motion: verify with OS/browser reduced-motion enabled.
- [ ] Build/typecheck: `npm run typecheck:web`, `npm run typecheck:api`, `npm run build`.
