import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { LocaleProvider } from "./i18n/locale.jsx";
import "./styles/base.css";
import "./features/atlas/atlas.css";
import "./features/hospital/hospital.css";
import "./features/audit/overview.css";
import "./features/audit/audit.css";
import "./features/review/review.css";
import "./features/changes/changes.css";

createRoot(document.getElementById("root")).render(<LocaleProvider><App /></LocaleProvider>);
