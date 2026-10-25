# Calibración de agy-flash (C8) — 2026-10-16 11:31 UTC

**5 de 5** corridas terminaron bien (sin falla de infraestructura). Son calibración: no son resultados.

| Corrida | Celda | Resultado | Turnos | Min | Tokens entrada | Salida (incl. thinking) | Thinking | Cuota 5 h | Cuota semanal |
|---|---|---|---|---|---|---|---|---|---|
| c8-0001 | V0·S2 | no_change | 41 | 5.77 | 160,987 | 30,857 | 13,777 | 0.9 % | 0.3 % |
| c8-0002 | V0·S0 | fixed_code | 68 | 10.05 | 247,639 | 26,606 | 9,288 | 1.6 % | 0.4 % |
| c8-0003 | V0·S2 | passed_first_ci | 49 | 5.33 | 209,119 | 12,865 | 4,219 | 1.0 % | 0.3 % |
| c8-0004 | V0·S0 | fixed_code | 74 | 9.13 | 300,819 | 29,647 | 9,906 | 2.1 % | 0.6 % |
| c8-0005 | V0·S0 | fixed_code | 77 | 9.3 | 415,801 | 27,149 | 8,433 | 2.1 % | 0.6 % |

## Para decidir si arranca P8 (N = 20 por celda, 120 corridas, ya fijado en el addendum)

- **Tokens por corrida (promedio):** 266,873 de entrada, 25,425 de salida (de ellos 9,125 de thinking).
- **Duración:** 7.92 min por corrida con CI y oráculo; 120 corridas ≈ 15.8 h con 1 worker, 5.3 h con 3.
- **Cuota de Google AI Pro:** cada corrida usó ≈ 1.5 % de la ventana de 5 h → ≈ 64 corridas por ventana; 120 piden ≈ 2 ventanas y quedan ≈ 33 antes del 23 oct: **alcanza**.
- **Tope semanal de Gemini** (se renueva el 23 oct): cada corrida usó ≈ 0.44 %; 120 piden ≈ 53 % y quedan 97 %: **alcanza**.
- **Referencia con API key** (Flash USD 0.75 / 3.75 por millón): ≈ USD 2.3798 por corrida, ≈ USD 285.57 las 120 (tokens de caché cobrados como entrada: cota alta).

**Decides tú:** ¿arranca P8? (sí / no). N no cambia: lo fija el addendum.
