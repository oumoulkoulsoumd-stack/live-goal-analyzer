import "./globals.css";

export const metadata = {
  title: "Live Goal Analyzer",
  description: "Analyse statistique de matchs de football en direct",
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
