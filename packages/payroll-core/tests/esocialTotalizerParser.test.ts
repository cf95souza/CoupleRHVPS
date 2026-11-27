import { describe, it, expect } from 'vitest';
import {
  buildSampleTotalizerXml,
  parseEsocialTotalizerXml,
  reconcileTotalizerWithMotor,
} from '../src/index.js';

describe('ESOC-04: Parser de Totalizadores eSocial (S-5001 a S-5013) & Confronto CoupleRH x Governo', () => {
  it('deve fazer parse de todos os 6 totalizadores oficiais e bater R$ 0,00 com o motor CoupleRH', () => {
    const motor = {
      inssSegurados: 583.22,
      inssPatronal: 1540.0,
      irrfRetido: 412.85,
      fgtsTotal: 440.0,
      maternityDeduction: 0,
      familySalaryDeduction: 0,
    };

    const s5001 = parseEsocialTotalizerXml(
      buildSampleTotalizerXml({
        eventType: 'S-5001',
        perApur: '2026-11',
        nrInsc: '12345678',
        cpfTrab: '11122233396',
        inssBase: 5500,
        inssSegurados: 583.22,
      })
    );
    expect(reconcileTotalizerWithMotor(s5001, motor).reconciliationStatus).toBe('MATCHED');

    const s5002 = parseEsocialTotalizerXml(
      buildSampleTotalizerXml({
        eventType: 'S-5002',
        perApur: '2026-11',
        nrInsc: '12345678',
        cpfTrab: '11122233396',
        irrfRetido: 412.85,
      })
    );
    expect(reconcileTotalizerWithMotor(s5002, motor).reconciliationStatus).toBe('MATCHED');

    const s5003 = parseEsocialTotalizerXml(
      buildSampleTotalizerXml({
        eventType: 'S-5003',
        perApur: '2026-11',
        nrInsc: '12345678',
        cpfTrab: '11122233396',
        fgtsBase: 5500,
        fgtsTotal: 440,
      })
    );
    expect(reconcileTotalizerWithMotor(s5003, motor).reconciliationStatus).toBe('MATCHED');

    const s5011 = parseEsocialTotalizerXml(
      buildSampleTotalizerXml({
        eventType: 'S-5011',
        perApur: '2026-11',
        nrInsc: '12345678',
        inssBase: 5500,
        inssSegurados: 583.22,
        inssPatronal: 1540,
        inssRat: 110,
        inssTerceiros: 330,
      })
    );
    expect(reconcileTotalizerWithMotor(s5011, motor).reconciliationStatus).toBe('MATCHED');

    const s5012 = parseEsocialTotalizerXml(
      buildSampleTotalizerXml({
        eventType: 'S-5012',
        perApur: '2026-11',
        nrInsc: '12345678',
        irrfRetido: 412.85,
      })
    );
    expect(reconcileTotalizerWithMotor(s5012, motor).reconciliationStatus).toBe('MATCHED');

    const s5013 = parseEsocialTotalizerXml(
      buildSampleTotalizerXml({
        eventType: 'S-5013',
        perApur: '2026-11',
        nrInsc: '12345678',
        fgtsBase: 5500,
        fgtsTotal: 440,
      })
    );
    const recon5013 = reconcileTotalizerWithMotor(s5013, motor);
    expect(recon5013.reconciliationStatus).toBe('MATCHED');
    expect(recon5013.maxAbsDiff).toBe(0);
  });

  it('deve acusar divergencia de R$ 0,01 entre eSocial e motor CoupleRH', () => {
    const s5011 = parseEsocialTotalizerXml(
      buildSampleTotalizerXml({
        eventType: 'S-5011',
        perApur: '2026-11',
        nrInsc: '12345678',
        inssBase: 5500,
        inssSegurados: 583.23, // R$ 0,01 acima do motor
        inssPatronal: 1540,
        inssRat: 110,
        inssTerceiros: 330,
      })
    );

    const recon = reconcileTotalizerWithMotor(s5011, {
      inssSegurados: 583.22,
      inssPatronal: 1540,
      irrfRetido: 412.85,
      fgtsTotal: 440,
    });

    expect(recon.reconciliationStatus).toBe('DIVERGENT');
    expect(recon.diffInssSegurados).toBe(0.01);
    expect(recon.maxAbsDiff).toBe(0.01);
    expect(recon.divergences).toHaveLength(1);
    expect(recon.divergences[0].field).toBe('inss_segurados');
  });
});
