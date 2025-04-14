# StreamCap

<p align="center"><img src="src/assets/logo.svg" width="150px" alt="StreamCap Logo" /><br/>
<img src="https://img.shields.io/badge/license-MIT-green?logo=github" alt="MIT License" />
<img src="https://img.shields.io/github/package-json/v/taichikuji/streamcap?label=version&logo=github" alt="Version" />
<img src="https://img.shields.io/github/last-commit/taichikuji/streamcap?logo=github" alt="Last Commit" />
</p>

## View, capture or record your webcam and game streams right in your browser!

StreamCap is a lightweight, browser-based application that allows you to easily view, capture screenshots, and record video from your Capture Device. Perfect for streamers, content creators, or anyone who needs quick access to their Capture Device feed without installing additional software.

## ✨ Features

- **Live Preview**: View your webcam or capture card feed directly in your browser
- **Screenshot Capture**: Take instant snapshots with a single click
- **Video Recording**: Record video from any connected device
- **Device Selection**: Choose from available audio and video input devices
- **Quality Control**: Select resolution and framerate for optimal performance
- **Responsive Design**: Works on desktop and mobile devices
- **No Installation**: Runs entirely in your web browser

## 🚀 Getting Started

### Prerequisites

- Node.js
- npm or yarn

### Installation

1. Clone this repository
   ```bash
   git clone https://github.com/taichikuji/streamcap.git
   cd streamcap
   ```

2. Install dependencies
   ```bash
   npm install
   # or
   yarn
   ```

3. Start the development server
   ```bash
   npm run dev
   # or
   yarn dev
   ```

4. Open your browser and navigate to `http://localhost:1234`

### Building for production

```bash
npm run build
# or
yarn build
```

The built files will be available in the `dist` directory.

## 🔧 Technologies Used

- <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/github/package-json/dependency-version/taichikuji/streamcap/dev/typescript?logo=typescript" alt="TypeScript" /></a>
- <a href="https://parceljs.org/"><img src="https://img.shields.io/github/package-json/dependency-version/taichikuji/streamcap/dev/parcel?logo=parcel" alt="Parcel" /></a>
- <a href="https://sass-lang.com/"><img src="https://img.shields.io/github/package-json/dependency-version/taichikuji/streamcap/dev/sass?logo=sass" alt="Sass" /></a>

### Dependencies

- <a href="https://www.npmjs.com/package/fix-webm-duration"><img src="https://img.shields.io/github/package-json/dependency-version/taichikuji/streamcap/fix-webm-duration" alt="fix-webm-duration" /></a>

## 🌐 Deployment

This project is set up for easy deployment to Netlify. The included `netlify.toml` file contains all necessary configuration.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/taichikuji/streamcap)

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Feel free to check the [issues page](https://github.com/taichikuji/streamcap/issues).
