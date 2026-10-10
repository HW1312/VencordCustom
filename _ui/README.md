# _ui – shared Apple style kit

Every own plugin uses this kit, so all of them look the same (macOS / iOS style, like AutoQuest).
`build.mjs` copies the folder into `Vencord/src/userplugins/_ui`; Vencord skips folders starting with `_`, so it is no plugin.

```ts
import { Sheet, openWindow, Section, Row, ToggleRow, Button, notify, ICONS } from "../_ui";
```

## Rules

1. **No own look for standard parts.** Windows, dialogs, lists, switches, segmented controls, buttons, text fields,
   search fields, empty states, notifications and confirm dialogs always come from the kit. A plugin's own CSS only
   styles what is special to it (e.g. a preview, a grid of cards, a chip inside the chat).
2. **Colors only from the tokens** (`var(--vc-ui-*)`), never hard-coded hex values or Discord brand colors
   (`--brand-*`, `#5865f2`). They follow Discord's light/dark theme automatically.
   - Text: `--vc-ui-title` (headings, row titles), `--vc-ui-text` (normal), `--vc-ui-dim` (secondary).
   - Surfaces: `--vc-ui-glass` (window), `--vc-ui-group` / `--vc-ui-group-hover` (grouped rows, cards),
     `--vc-ui-field` (inputs, gray buttons), `--vc-ui-track` (switch/segment track), `--vc-ui-sep` (hairlines),
     `--vc-ui-edge` (0.5px borders).
   - System colors: `--vc-ui-blue` (accent, links, main buttons), `green` (on / success), `orange` (attention),
     `red` (destructive / error), `purple`, `indigo`, `teal`, `mint`, `yellow`, `pink`, `gray`.
   - Fonts: `--vc-ui-font`, `--vc-ui-font-display`, `--vc-ui-mono`. Motion: `--vc-ui-spring`, `--vc-ui-ease`.
3. **Shapes:** windows 22px, popovers 18px, groups/cards 12px, fields 10px, glyphs ~25% of their size, buttons are
   capsules. Hairlines are 0.5px. No heavy borders, no gradients except app icons/glyphs (`.vc-ui-fill-<color>`).
4. **Type:** row titles 14px/500, secondary 12px dim, section titles 12px uppercase dim, window title 20px/700.
5. **Every plugin has an app icon color** (`iconColor`), used for its window header and settings rows.
6. Texts stay English (all plugin text is English).
7. **Never create JSX at module level** (e.g. `const STEPS = [<>…</>]`). It runs while the plugin file loads, before
   Vencord exists, and crashes the whole client (all plugins gone). Wrap it in a function: `const steps = () => [...]`.

## Building blocks

| Need | Use |
| --- | --- |
| Window (modal) | `openWindow(close => <Sheet header={{ title, subtitle, icon, iconColor, actions }} onClose={close} top={…} actions={[…]}>…</Sheet>, { size: "small" \| "medium" \| "large" })` |
| Settings page / panel inside Vencord settings | `<Sheet embedded header={…}>…</Sheet>` (no fixed height, no own scroll) |
| Popout / floating panel | `<Popover width={360}>…</Popover>` (glass card; a normal `<Sheet>` directly inside adapts its spacing) |
| Tabs | `<Segmented value options={[{ value, label, count }]} onChange />` (use `top` of the Sheet so it stays fixed; a value matching no option = nothing selected) |
| Big numbers | `<Stats items={[{ value, label, color }]} />` |
| Grouped list | `<Section title footer right>` + `<Row leading title subtitle note trailing onClick chevron dim />` |
| Setting with switch | `<ToggleRow icon color title subtitle checked onChange />` |
| Several cards in one section | `<Section plain>` + `<Group>` per card |
| Row with several lines | `<Row align="top" …>` |
| Blue action row at the end of a group | `<LinkRow icon onClick>Add…</LinkRow>` |
| Filter tags, quick picks, removable chips | `<Pills>` + `<Pill selected onClick onRemove icon leading>` |
| Slider | `<Slider value min max step format={v => `${v}%`} onChange />` |
| Icons in front of rows | `<Glyph path color />` (settings) or `<AppIcon path color size={40} />` / `<Avatar src />` |
| Buttons | `<Button variant="filled" \| "tinted" \| "gray" \| "plain" \| "destructive" color small icon wide>` |
| Round header/toolbar button | `<RoundButton icon label onClick />` |
| Row action icons | `<IconButton icon label onClick destructive />` |
| Status at the right of a row | `<State tone="ok" \| "warn" \| "bad" spinner check>` , `<Badge color solid icon title onClick>` |
| Inputs | `<SearchField>` (takes normal input props like onKeyDown), `<TextField>`, `<TextArea>`, `<Select options width>`, wrapped in `<Field label hint>` |
| Warning above dialog buttons | `<Sheet notice="…">` |
| Progress / busy | `<Progress value color />`, `<Spinner />` |
| Empty list | `<Empty icon title hint>{optional button}</Empty>` |
| Info / warning box | `<Note tone="warn">` |
| Confirm before deleting | `await confirm({ title, body, confirmText: "Delete", destructive: true })` |
| Alert with several choices | `await openAlert({ title, body, icon, buttons: [...] })` → index |
| Notification (instead of Discord toasts for plugin events) | `notify({ title, body, kind: "success" \| "attention" \| "info" \| "error", app: "PluginName", image, onClick })` |
| Title bar icon hover | add `vc-ui-tb-icon` to the svg |

Short feedback after a click (copied, saved) may still use Discord's `showToast(text, "success")` – that is fine.

## Migrating a plugin

1. Replace the plugin's own window/modal shell with `openWindow` + `Sheet` (Discord's `Modal` with `title`/`actions`
   becomes `Sheet` with `header` and `actions`).
2. Replace own switches, tabs, buttons, inputs, list rows, empty states, toasts and confirm dialogs by kit parts.
   Delete the now unused CSS. Keep behaviour, settings keys and texts identical unless they were wrong.
3. Restyle what is left in the plugin's CSS with the tokens above (no hard-coded colors, 0.5px hairlines, radii as above).
4. Elements inside Discord (title bar buttons, chips under messages, cards in chat, context menu icons) keep their
   size and place but use the tokens and shapes, so they feel like the windows.
5. Build (`node build.mjs`) and type-check (`cd Vencord && npx tsc --noEmit -p .`), fix every error in the plugin.
