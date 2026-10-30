// Hash router: #/view/param?query
import { useEffect, useState } from '/vendor/htm-preact.js';

export function parse() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { view: parts[0] || 'home', param: parts[1] ? decodeURIComponent(parts[1]) : null, query: new URLSearchParams(query || '') };
}

export function navigate(to) {
  const next = '#' + (to.startsWith('/') ? to : '/' + to);
  if (location.hash !== next) location.hash = next;
}

export function useRoute() {
  const [route, setRoute] = useState(parse());
  useEffect(() => {
    const f = () => setRoute(parse());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return route;
}
