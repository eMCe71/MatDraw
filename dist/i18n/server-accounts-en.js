// English entries (Polish key -> English): messages of sign-up with roles, the roles and organizer-unlock routes, member commands and account removal (slice accounts-backend, §4.5, §4.6, §6.6, §8.3).
// Registered empty in wave 1 by the slice data-domain, so slices of one wave never edit the same file; merged in i18n.js (first wins),
// tests/i18n.test.mjs lists the dictionaries and requires no collisions.
export default {
 // Roles of a member account (§4.5, §3.7).
 'Administrator wyłączył Ci rolę organizatora.':'The Administrator has turned off your organizer role.',
 'Masz turnieje z otwartymi lub zamkniętymi zapisami. Zakończ je albo przełącz na roboczy, zanim wyłączysz rolę organizatora.':'You have tournaments with open or closed registration. Finish them or switch them to draft before you turn off the organizer role.',
 'Zbyt wiele nowych kont organizatorów z tej sieci. Spróbuj ponownie jutro.':'Too many new organizer accounts from this network. Try again tomorrow.',
 'Zbyt wiele zmian ról. Spróbuj ponownie później.':'Too many role changes. Try again later.',
 // Organizer tools: password step-up and limits (§4.6, §3.7).
 'Potwierdź hasło, aby otworzyć narzędzia organizatora.':'Confirm your password to open the organizer tools.',
 'Nieprawidłowe hasło.':'Incorrect password.',
 'Zbyt wiele operacji. Spróbuj ponownie za chwilę.':'Too many operations. Try again in a moment.',
 'Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.':'The server is very busy right now. Try again in a moment.',
};
