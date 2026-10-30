# MatDraw v3 validation — 2026-10-29

Passed 20 automated tests: 11 existing JavaScript rule tests, 5 multi-tournament/role tests, 3 PHP domain/parity tests, and one real HTTP/PHP/MariaDB integration scenario with multiple assertions.

PHP 8.3.6 / MariaDB 10.11.14 were run locally with an isolated disposable test database. The installed release package was exercised through its public API, not only through domain mocks. Confirmed anonymous denial, CSRF rejection, account creation, club-derived ownership, cross-club denial, editor ownership, same-athlete registration in two tournaments, age on each event date, isolated weigh-in and snapshots, duplicate entry denial, rollback of combined creation/registration, date lock, closed/finished guards, last-admin protection, password change, blocked-account session revocation, logout, no private hashes in API responses, and two concurrent writes yielding one success and one 409.

PHP and JavaScript classification agree on 448 boundary combinations. PHP and JavaScript draws cover 3–64 entrants, preserving all entrants and producing n−1 played matches. PHP syntax checks and application JavaScript syntax checks pass.

Browser QA: desktop admin login via demo shortcut; creation of a third tournament; accounts/roles view; club login; filtering to 8 own-club profiles; registering an existing athlete in the newly created tournament. Mobile login and tournament collection checked at 390 px iframe width (375 px content); no horizontal body overflow. MEDUCASE logo and link preserved. All browser data were fictional demo data.

Deployment boundary: PHP backend tested locally, not deployed to the owner's PHP hosting. Sites publication runs demo adapter only. Existing print/projector features are retained; physical printer/projector and the owner's PHP hosting remain to be checked at installation. Rule ambiguities remain documented in the app.
