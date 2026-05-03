# Peripheral

Peripheral is a browser-based webcam effect that keeps the center of the frame relatively clear while degrading detail toward the edges into noisy Voronoi-like cells.

From a user perspective, this feels like peripheral vision simulation:

- Center region: higher detail and finer cells
- Periphery: larger, noisier cell regions with reduced effective detail
- Live controls: tune how strong and how smooth the effect feels in real time

## Features

- Live webcam processing in the browser (no backend)
- Radially weighted Voronoi-like sampling
- Organic periphery abstraction with stable Voronoi-like cells
- Real-time controls for:
  - Seed Count
  - Center Radius
  - Falloff Width
- Status indicators for camera state, FPS, and processing resolution

## Tech Stack

- Vanilla HTML/CSS/JavaScript
- Canvas 2D rendering
- `http-server` for local static serving

## Local Development

### Prerequisites

- Node.js + npm
- OpenSSL available on PATH

### Install

```bash
npm install
```

### Run (HTTPS local dev)

```bash
npm run dev
```

The `dev` script currently performs the secure local flow through package scripts:

1. `cert:prepare` - ensures the `cert` directory exists
2. `cert:generate` - generates a self-signed localhost certificate and key
3. `dev:https` - starts `http-server` over HTTPS on port `5173`

Open:

- `https://127.0.0.1:5173`
- or `https://localhost:5173` (if listed by your server output)

## First-Run Notes

- Browser will likely show a warning for the self-signed certificate.
- The app attempts to start the camera automatically on page load.
- Allow camera access when the browser permission prompt appears.
- Webcam APIs require a secure context, so `file://` is not sufficient.

## Deployment Notes

For GitHub Pages, you do **not** need to ship your local certs.
GitHub Pages serves over trusted HTTPS, so users just grant camera permission in-browser.

## Project Structure

- `index.html` - UI layout and controls
- `styles.css` - visual design and responsive layout
- `app.js` - webcam capture, effect pipeline, render loop, and controls
- `package.json` - local development scripts
- `cert/` - local self-signed cert artifacts (development only)

## Troubleshooting

- Camera not available:
  - Check browser site permissions
  - Confirm another app is not locking the camera
- OpenSSL command not found:
  - Install OpenSSL and ensure it is on PATH
- Browser still blocks camera on local dev:
  - Verify you are on `https://...`, not `http://...` or `file://...`
- Performance is choppy:
  - Reduce Seed Count
  - Reduce browser tab and background app load
