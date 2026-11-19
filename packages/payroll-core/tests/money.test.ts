import { describe, it, expect } from 'vitest';
import {
  round2,
  toCents,
  fromCents,
  addMoney,
  subtractMoney,
  multiplyMoney,
  divideMoney,
  sumMoney,
  moneyEquals,
  formatBRL
} from '../src/utils/money.js';

describe('money.ts - Precisao Monetaria e Arredondamento Contabil HALF_UP', () => {
  it('deve arredondar com politica HALF_UP com precisao comercial', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(1.004)).toBe(1.00);
    expect(round2(2500.555)).toBe(2500.56);
    expect(round2(-1.005)).toBe(-1.01);
  });

  it('deve converter corretamente entre reais e centavos inteiros', () => {
    expect(toCents(1234.56)).toBe(123456);
    expect(fromCents(123456)).toBe(1234.56);
    expect(toCents(0.1 + 0.2)).toBe(30); // elimina anomalia float IEEE 754
  });

  it('deve somar e subtrair sem erros de ponto flutuante', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(subtractMoney(1.0, 0.9)).toBe(0.1);
  });

  it('deve multiplicar e dividir com arredondamento HALF_UP', () => {
    expect(multiplyMoney(1518.0, 0.075)).toBe(113.85);
    expect(divideMoney(3000.0, 30)).toBe(100.0);
    expect(divideMoney(100.0, 3)).toBe(33.33);
  });

  it('deve suportar sumMoney tanto como array quanto spread sem erros', () => {
    expect(sumMoney([10.5, 20.25, 30.25])).toBe(61.0);
    expect(sumMoney(10.5, 20.25, 30.25)).toBe(61.0);
  });

  it('deve verificar igualdade em centavos e formatar BRL', () => {
    expect(moneyEquals(10.0, 10.0001)).toBe(true);
    expect(formatBRL(1234.56)).toContain('1.234,56');
  });
});