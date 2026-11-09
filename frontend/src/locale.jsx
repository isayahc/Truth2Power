import React, { createContext, useContext, useEffect, useState } from 'react';
import { spanish } from './spanish.js';

const Locale = createContext({ language: 'en', t: (text) => text, localHref: (href) => href });
function initialLanguage() {
  const requested = new URLSearchParams(window.location.search).get('lang');
  if (['en', 'es'].includes(requested)) return requested;
  try { return localStorage.getItem('t2p-language') === 'es' ? 'es' : 'en'; }
  catch { return 'en'; }
}

export function LocaleProvider({ children }) {
  const [language, updateLanguage] = useState(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'es' ? 'Truth2Power · Hospitales de Nueva York' : 'Truth2Power · New York hospitals';
    try { localStorage.setItem('t2p-language', language); } catch { /* Storage may be blocked. */ }
  }, [language]);
  useEffect(() => {
    const restore = () => updateLanguage(initialLanguage());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  function setLanguage(next) {
    if (!['en', 'es'].includes(next)) return;
    updateLanguage(next);
    const url = new URL(window.location.href);
    url.searchParams.set('lang', next);
    window.history.replaceState(null, '', url);
  }
  const t = (text) => language === 'es' ? spanish[text] ?? text : text;
  const localHref = (href) => {
    if (language !== 'es') return href;
    const url = new URL(href, window.location.href);
    url.searchParams.set('lang', 'es');
    return url.pathname + url.search + url.hash;
  };
  return <Locale.Provider value={{ language, setLanguage, t, localHref }}>{children}</Locale.Provider>;
}

export const useLocale = () => useContext(Locale);

export function LanguageSwitch() {
  const { language, setLanguage } = useLocale();
  return <nav className="language-switch" aria-label="Language / Idioma">
    <button lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>English</button>
    <button lang="es" aria-pressed={language === 'es'} onClick={() => setLanguage('es')}>Español</button>
  </nav>;
}
