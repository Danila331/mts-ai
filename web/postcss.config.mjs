// Tailwind CSS v4 через PostCSS — штатная схема Next.js: dev-сервер видит правки globals.css и новые классы на лету.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
