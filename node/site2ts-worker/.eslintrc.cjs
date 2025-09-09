module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['import'],
  extends: ['eslint:recommended', 'plugin:import/recommended', 'prettier'],
  rules: {
    'no-console': 'off'
  },
  settings: {
    'import/resolver': {
      node: { extensions: ['.js', '.mjs', '.ts'] }
    }
  }
};

