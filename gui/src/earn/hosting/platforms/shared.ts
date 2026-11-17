// The starter page the download folders and file blocks hand out.

/** The starter page in the download folder: a welcome screen for a fresh data host. */
export const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VibeShare data host</title>
    <style>
        body {
            font: 16px/1.6 system-ui, sans-serif;
            max-width: 640px;
            margin: 15vh auto;
            padding: 0 20px;
            color: #222;
        }
        h1 {
            font-size: 22px;
        }
        code {
            background: #f2f2f7;
            padding: 2px 6px;
            border-radius: 6px;
        }
    </style>
</head>
<body>
    <h1>VibeShare data host</h1>
    <p>
        This site hosts content for VibeShare provider jobs: every content id lives at
        <code>&lt;base&gt;/&lt;content-id&gt;</code>, and providers download the bytes from here and pay for them.
    </p>
    <p>
        Content ids are pushed into the <code>public</code> folder of this site.
        This page is only the welcome screen.
    </p>
</body>
</html>`;
