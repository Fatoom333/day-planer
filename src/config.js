// OAuth Client ID из Google Cloud (тип «Web application»). Он публичный по природе:
// защиту даёт список разрешённых origin в Google Cloud, а не секретность ID.
// Client secret здесь не нужен и в репозиторий не попадает никогда.
// Как получить ID — docs/google-setup.md. После замены подними VERSION в sw.js.
export const GOOGLE_CLIENT_ID = '780143042227-cqdlokcikr2njoopqtoh6iv1p9b6i7br.apps.googleusercontent.com';
