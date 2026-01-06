import React from "react";

export const metadata = {
  title: "MVVC Coach Copilot",
  description: "Team-private, data-backed coaching assistant",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}

        {/* Global styles (mobile-first, professional look) */}
        <style jsx global>{`
          :root {
            --bg: #0b1020;
            --panel: rgba(255, 255, 255, 0.06);
            --panel-2: rgba(255, 255, 255, 0.08);
            --border: rgba(255, 255, 255, 0.12);
            --text: rgba(255, 255, 255, 0.92);
            --muted: rgba(255, 255, 255, 0.68);
            --muted-2: rgba(255, 255, 255, 0.55);
            --danger: #ff5a6a;
            --accent: #7c5cff;
            --accent-2: #2ee59d;
            --shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
            --radius: 18px;
            --radius-sm: 12px;
          }

          * { box-sizing: border-box; }
          html, body { height: 100%; }
          body {
            margin: 0;
            font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
            color: var(--text);
            background:
              radial-gradient(1200px 800px at 10% 20%, rgba(124, 92, 255, 0.35), transparent 55%),
              radial-gradient(900px 700px at 85% 10%, rgba(46, 229, 157, 0.25), transparent 60%),
              radial-gradient(800px 800px at 70% 90%, rgba(255, 90, 106, 0.12), transparent 55%),
              var(--bg);
          }

          a { color: inherit; text-decoration: none; }
          button, input, textarea { font: inherit; }

          /* Better mobile viewport behavior */
          .app-shell {
            min-height: 100vh;
            min-height: 100dvh;
            padding: 14px;
            display: flex;
            justify-content: center;
          }

          @media (min-width: 900px) {
            .app-shell { padding: 24px; }
          }
        `}</style>
      </body>
    </html>
  );
}
