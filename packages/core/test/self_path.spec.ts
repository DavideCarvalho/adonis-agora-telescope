import { describe, expect, it } from 'vitest';
import { isUnder } from '../src/telescope_middleware.js';

/**
 * O console não se mede.
 *
 * Seus endpoints de agregação estão entre os mais lentos que o processo serve — é
 * literalmente o trabalho deles. Abrir o Overview gravava mais duas requests lentas
 * no ranking e no p99 do APP. Em produção a lista "Slowest" veio assim:
 *
 *   GET /                                    3.53s
 *   GET /telescope/api/metrics/timeseries    3.00s
 *   GET /telescope/api/metrics/pulse         2.90s
 *
 * Duas rotas do próprio telescope no top 5 — o console competindo com a aplicação
 * na lista da própria aplicação.
 */
describe('isUnder — o prefixo que o middleware pula', () => {
  it('pula o próprio prefixo e tudo abaixo dele', () => {
    expect(isUnder('/telescope', '/telescope')).toBe(true);
    expect(isUnder('/telescope/api/metrics/pulse', '/telescope')).toBe(true);
    expect(isUnder('/telescope/client-errors', '/telescope')).toBe(true);
  });

  it('ignora a query string', () => {
    expect(isUnder('/telescope/api/entries?type=log', '/telescope')).toBe(true);
  });

  it('NÃO engole rota do app que só começa parecido', () => {
    // Este é o ponto do teste. Um `startsWith('/telescope')` cru tornaria
    // /telescopes invisível no console — o mesmo tipo de silêncio que este fix
    // existe pra remover, só que causado por ele.
    expect(isUnder('/telescopes', '/telescope')).toBe(false);
    expect(isUnder('/telescope-pricing', '/telescope')).toBe(false);
    expect(isUnder('/telescopio', '/telescope')).toBe(false);
  });

  it('rota comum do app não é afetada', () => {
    expect(isUnder('/pesquisador/escrita', '/telescope')).toBe(false);
    expect(isUnder('/', '/telescope')).toBe(false);
  });

  it('funciona com prefixo customizado', () => {
    expect(isUnder('/__telescope/api/meta', '/__telescope')).toBe(true);
    expect(isUnder('/admin/obs/api', '/admin/obs')).toBe(true);
    expect(isUnder('/admin/observability', '/admin/obs')).toBe(false);
  });
});
