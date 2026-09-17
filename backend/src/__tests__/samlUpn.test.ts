/**
 * Tests for UPN extraction from the SAML assertion (`auth/saml.ts`).
 *
 * The platform-administrator convention is evaluated on the UPN, not on the
 * mail address: administrative accounts routinely have no mailbox, so a rule
 * keyed on mail missed exactly the accounts it existed for —
 * `admin365-…@dompe.onmicrosoft.com` signed in and landed `pending`.
 *
 * The delicate part is source precedence. Entra maps `name` to
 * `user.userprincipalname` by default, which is the case in this tenant, but a
 * tenant that remapped it to a display name must not have that mistaken for an
 * address.
 */
import { describe, it, expect } from 'vitest';
import { extractUpn, buildDisplayName } from '../auth/saml.js';

describe('extractUpn', () => {
  it('prefers the canonical upn claim', () => {
    expect(
      extractUpn({
        upnClaim: 'admin365-bernasconi@dompe.onmicrosoft.com',
        nameClaim: 'tommaso.bernasconi@dompe.com',
        nameID: 'opaque',
      }),
    ).toBe('admin365-bernasconi@dompe.onmicrosoft.com');
  });

  it('falls back to the name claim when it is address-shaped', () => {
    // This tenant's actual configuration: name carries the UPN.
    expect(
      extractUpn({
        upnClaim: '',
        nameClaim: 'tommaso.bernasconi@dompe.com',
        nameID: '6oa2V1lefQjTwB8_lW_Y47cQj',
      }),
    ).toBe('tommaso.bernasconi@dompe.com');
  });

  it('ignores a name claim that holds a display name', () => {
    // A tenant that remapped `name`; mistaking this for an address would put a
    // person's name where an administrator expects an account.
    expect(
      extractUpn({ upnClaim: '', nameClaim: 'Bernasconi Tommaso', nameID: 'opaque-persistent-id' }),
    ).toBe('');
  });

  it('falls back to an address-shaped NameID', () => {
    // True with the emailAddress identifier format, not with persistent.
    expect(
      extractUpn({ upnClaim: '', nameClaim: '', nameID: 'mario.rossi@dompe.com' }),
    ).toBe('mario.rossi@dompe.com');
  });

  it('returns empty when no source carries an address', () => {
    expect(extractUpn({ upnClaim: '', nameClaim: '', nameID: '' })).toBe('');
    expect(
      extractUpn({ upnClaim: '', nameClaim: 'Mario Rossi', nameID: 'persistent-opaque' }),
    ).toBe('');
  });

  it('rejects malformed addresses rather than passing them on', () => {
    for (const bad of ['@dompe.com', 'mario@', '@', 'mario.rossi']) {
      expect(extractUpn({ upnClaim: bad, nameClaim: '', nameID: '' })).toBe('');
    }
  });

  it('trims surrounding whitespace', () => {
    expect(
      extractUpn({ upnClaim: '  mario.rossi@dompe.com  ', nameClaim: '', nameID: '' }),
    ).toBe('mario.rossi@dompe.com');
  });
});

describe('buildDisplayName', () => {
  it('prefers the real name over the UPN in the name claim', () => {
    // Why the two are separate: with name mapped to the UPN, using it as the
    // display name showed an address wherever a person was meant.
    expect(
      buildDisplayName({
        givenName: 'Tommaso',
        surname: 'Bernasconi',
        nameClaim: 'tommaso.bernasconi@dompe.com',
        nameID: 'opaque',
      }),
    ).toBe('Tommaso Bernasconi');
  });

  it('falls back to the name claim when no given/surname arrived', () => {
    expect(
      buildDisplayName({ givenName: '', surname: '', nameClaim: 'Mario Rossi', nameID: 'opaque' }),
    ).toBe('Mario Rossi');
  });
});
