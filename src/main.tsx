// Polyfills MUST come first — before App and any Solana lib that uses Buffer.
import './polyfills';
import '@solana/wallet-adapter-react-ui/styles.css';
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
