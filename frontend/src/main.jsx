import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./atlas.css";
import { LocaleProvider } from './locale.jsx';

createRoot(document.getElementById("root")).render(<LocaleProvider><App /></LocaleProvider>);
