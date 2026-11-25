import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/overpass/400.css";
import "@fontsource/overpass/600.css";
import "@fontsource/overpass/800.css";
import "./styles.css";
import App from "./App";
import AuthGate from "./Auth";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>{(user, signOut) => <App user={user} onSignOut={signOut} />}</AuthGate>
  </StrictMode>,
);
