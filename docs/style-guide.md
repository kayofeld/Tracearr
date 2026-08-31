# Tracearr Brand Style Guide

## 1. Core Brand Concept

Tracearr's visual identity reflects:

- **Security** — controlled access, protection, enforcement
- **Visibility** — tracing sessions, device intel, location anomalies
- **Modern simplicity** — clean geometry, minimal noise, premium feel
- **Tech-forward aesthetic** — gradients, subtle glow, deep contrast

---

## 2. Logo System

### Primary Logo (Horizontal)

Shield icon left + "TRACEARR" wordmark.

### Icon-Only Logo

Shield monogram with stylized T-path + radar arcs.

### Safe Spacing & Minimum Size

- Clearspace around the logo = height of the dot at the bottom of the shield.
- Minimum display:
  - Icon only: **24×24 px**
  - Full logo: **140 px width**

### Backgrounds

- Solid dark or solid light backgrounds recommended.
- Avoid busy imagery behind the logo.

---

## 3. Color System Architecture

Tracearr uses an **HSL-based color system** with a **dynamic accent hue** for theme customization. This enables consistent theming across web and mobile while allowing future accent color variations.

### 3.1 Accent Hue System

The primary accent color is derived from a single `--accent-hue` CSS variable:

```css
--accent-hue: 187; /* Default: Cyan */
```

**Available Accent Options:**

| Name   | Hue | Example Use Case     |
| ------ | --- | -------------------- |
| Cyan   | 187 | Default brand accent |
| Blue   | 220 | Corporate/enterprise |
| Purple | 270 | Creative/premium     |
| Pink   | 330 | Playful/modern       |
| Red    | 0   | Urgent/alert-focused |
| Orange | 24  | Warm/energetic       |
| Green  | 150 | Growth/success       |

### 3.2 Brand Colors (Derived from Accent)

| Name       | HSL                            | Usage                  |
| ---------- | ------------------------------ | ---------------------- |
| Cyan Core  | `hsl(--accent-hue 80% 50%)`    | Primary accent, CTA    |
| Cyan Deep  | `hsl(--accent-hue 86% 42%)`    | Hover states, gradient |
| Cyan Dark  | `hsl(--accent-hue 85% 31%)`    | Shadows, outlines      |
| Blue Core  | `hsl(213 62% 11%)` / `#0B1A2E` | Legacy dark cards      |
| Blue Steel | `hsl(213 47% 17%)` / `#162840` | Legacy panels          |
| Blue Soft  | `hsl(212 49% 24%)` / `#1E3A5C` | Legacy hover states    |

---

## 4. Theme Palettes

### 4.1 Dark Mode (Primary)

Uses **shadcn/ui neutral** color scheme with accent-derived primary colors.

**Backgrounds**

| Token      | HSL          | Approx Hex | Usage            |
| ---------- | ------------ | ---------- | ---------------- |
| background | `240 10% 4%` | `#09090b`  | Main background  |
| card       | `240 10% 4%` | `#09090b`  | Cards            |
| popover    | `240 10% 4%` | `#09090b`  | Dropdowns/modals |
| muted      | `240 4% 16%` | `#27272a`  | Subtle surfaces  |
| secondary  | `240 4% 16%` | `#27272a`  | Secondary fills  |

**Text**

| Token            | HSL          | Approx Hex | Usage     |
| ---------------- | ------------ | ---------- | --------- |
| foreground       | `0 0% 98%`   | `#fafafa`  | Primary   |
| muted-foreground | `240 5% 65%` | `#a1a1aa`  | Secondary |

**Borders & Inputs**

| Token  | HSL          | Usage                 |
| ------ | ------------ | --------------------- |
| border | `240 4% 16%` | All borders           |
| input  | `240 4% 16%` | Form input background |
| ring   | Accent-based | Focus rings           |

**Accent Colors**

| Token              | HSL                    | Usage             |
| ------------------ | ---------------------- | ----------------- |
| primary            | `--accent-hue 80% 50%` | CTAs, links       |
| primary-foreground | `240 6% 10%`           | Text on primary   |
| accent             | `240 4% 16%`           | Hover backgrounds |
| accent-foreground  | `0 0% 98%`             | Text on accent    |

**Semantic Colors**

| Token                  | HSL           | Usage          |
| ---------------------- | ------------- | -------------- |
| destructive            | `0 62% 50%`   | Errors, delete |
| destructive-foreground | `0 0% 98%`    | Text on red    |
| success (custom)       | `142 76% 36%` | Success states |
| warning (custom)       | `38 92% 50%`  | Warnings       |

---

### 4.2 Light Mode

Uses **shadcn/ui neutral** color scheme with darker accent for readability.

**Backgrounds**

| Token      | HSL          | Approx Hex | Usage           |
| ---------- | ------------ | ---------- | --------------- |
| background | `0 0% 100%`  | `#ffffff`  | Main background |
| card       | `0 0% 100%`  | `#ffffff`  | Cards           |
| muted      | `240 5% 96%` | `#f4f4f5`  | Subtle surfaces |

**Text**

| Token            | HSL          | Usage     |
| ---------------- | ------------ | --------- |
| foreground       | `240 10% 4%` | Primary   |
| muted-foreground | `240 4% 46%` | Secondary |

**Accent Colors (Darker for Contrast)**

| Token              | HSL                    | Usage       |
| ------------------ | ---------------------- | ----------- |
| primary            | `--accent-hue 85% 38%` | CTAs, links |
| primary-foreground | `0 0% 100%`            | White text  |

---

## 5. Chart Colors

Charts use a consistent 5-color palette across themes:

### Dark Mode

| Token   | HSL                    | Usage                |
| ------- | ---------------------- | -------------------- |
| chart-1 | `--accent-hue 80% 50%` | Primary series       |
| chart-2 | `--accent-hue 70% 60%` | Secondary series     |
| chart-3 | `197 37% 50%`          | Tertiary (neutral)   |
| chart-4 | `43 80% 55%`           | Warning/amber series |
| chart-5 | `0 75% 55%`            | Danger/red series    |

### Light Mode

| Token   | HSL                    | Usage                |
| ------- | ---------------------- | -------------------- |
| chart-1 | `--accent-hue 85% 38%` | Primary series       |
| chart-2 | `--accent-hue 70% 50%` | Secondary series     |
| chart-3 | `197 37% 24%`          | Tertiary (neutral)   |
| chart-4 | `43 90% 45%`           | Warning/amber series |
| chart-5 | `0 72% 51%`            | Danger/red series    |

---

## 6. Icon Colors

| Token       | Dark Mode HSL          | Light Mode HSL         | Usage         |
| ----------- | ---------------------- | ---------------------- | ------------- |
| icon        | `240 5% 65%`           | `240 4% 46%`           | Default state |
| icon-active | `--accent-hue 80% 50%` | `--accent-hue 85% 38%` | Active/hover  |
| icon-danger | `0 100% 65%`           | `0 72% 51%`            | Danger states |

**Icon Guidelines:**

- Stroke width: 1.75–2px
- Rounded corners
- No filled icons except for critical warnings

---

## 7. Sidebar Colors

The sidebar uses slightly elevated backgrounds for visual separation:

### Dark Mode

| Token                      | HSL                    | Usage            |
| -------------------------- | ---------------------- | ---------------- |
| sidebar                    | `240 6% 10%`           | Background       |
| sidebar-foreground         | `0 0% 98%`             | Text             |
| sidebar-primary            | `--accent-hue 80% 50%` | Active items     |
| sidebar-primary-foreground | `240 6% 10%`           | Text on active   |
| sidebar-accent             | `240 4% 16%`           | Hover background |
| sidebar-border             | `240 4% 16%`           | Dividers         |

### Light Mode

| Token                      | HSL                    | Usage          |
| -------------------------- | ---------------------- | -------------- |
| sidebar                    | `0 0% 98%`             | Background     |
| sidebar-foreground         | `240 6% 10%`           | Text           |
| sidebar-primary            | `--accent-hue 85% 38%` | Active items   |
| sidebar-primary-foreground | `0 0% 100%`            | Text on active |

---

## 8. Typography

**Primary Font:** Inter

Weights:

- 700 (Bold)
- 500 (Medium)
- 400 (Regular)
- 300 (Light)

**Fallback Stack:**

```
Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
```

---

## 9. UI Elements

### Buttons

**Primary Button**

- Background: `primary` token (accent-derived)
- Hover: Slightly darker accent
- Text: `primary-foreground`
- Radius: `--radius` (0.5rem default)

**Secondary Button**

- Background: `secondary` token
- Text: `secondary-foreground`
- Hover: Slightly lighter

**Destructive Button**

- Background: `destructive` token
- Text: `destructive-foreground`

### Border Radius

| Token     | Value                |
| --------- | -------------------- |
| radius    | `0.5rem` (base)      |
| radius-sm | `calc(radius - 4px)` |
| radius-md | `calc(radius - 2px)` |
| radius-lg | `radius`             |
| radius-xl | `calc(radius + 4px)` |

---

## 10. Shadows & Effects

- Logo glow: `0px 0px 14px rgba(24, 209, 231, 0.22)`
- Dark mode panel shadow: `0px 4px 12px rgba(0, 0, 0, 0.35)`
- Focus ring: Uses `ring` token with appropriate opacity

---

## 11. Implementation Notes

### CSS Variables Location

- **Web:** `apps/web/src/styles/globals.css`
- **Mobile:** `global.css` in the [Mobile-App repo](https://github.com/Tracearr/Mobile-App)

### Theme Switching

The web app supports light/dark mode via the `.dark` class on the document root. Mobile is dark-mode only.

### Customizing Accent Color

**Web:** Update the `--accent-hue` variable for runtime theme switching:

```css
:root {
  --accent-hue: 220; /* Blue instead of Cyan */
}
```

All accent-derived colors will automatically update.

**Mobile:** NativeWind processes `@theme` at build time, so mobile uses static HSL values (`hsl(187 80% 50%)` for cyan). To change the mobile accent color, update the hardcoded hue values in the mobile repo's `global.css`.

---

## 12. Brand Tone

Tracearr should feel:

- Authoritative but friendly
- Technical but approachable
- Privacy-conscious
- Clear, concise, no fluff
