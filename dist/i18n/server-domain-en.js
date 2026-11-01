// English entries of the workspace rules for roles, organizers, athlete profiles, self-entries and clubs (Polish key -> English):
// messages of backend/src/{Domain,Clubs,Repository}.php and their mirror dist/workspace.js, and the tournament log entries they
// write (PLAN-REJESTRACJA-ROLE §8.3). Merged in i18n.js (first wins); tests/i18n.test.mjs requires an entry for every server message
// and no collisions.
export default {
 // Organizer limits, status and texts (§5.4).
 'Limit nowych turniejów: 3 na dobę.':'New tournament limit: 3 per day.',
 'Masz już 10 opublikowanych nadchodzących turniejów. Przełącz któryś na roboczy albo poczekaj, aż się odbędzie.':'You already have 10 published upcoming tournaments. Switch one of them to draft or wait until it takes place.',
 'Dziś powstało już bardzo dużo nowych turniejów. Spróbuj ponownie jutro albo napisz do nas.':'A very large number of new tournaments has been created today. Try again tomorrow or write to us.',
 'Limit nowych zawodników na dziś został osiągnięty.':'The limit of new athletes for today has been reached.',
 'Turniej ukrył Administrator. Status może zmienić tylko Administrator.':'The Administrator has hidden this tournament. Only the Administrator can change its status.',
 'Turniej można zakończyć najwcześniej w dniu zawodów.':'A tournament can be finished on the day of the competition at the earliest.',
 'Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.':'Publishing new community tournaments is temporarily paused by the Administrator.',
 'Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.':'The name must not contain a web address, an email or a long number.',
 'Zaznacz, że masz zgodę rodzica lub opiekuna na podanie danych zawodnika.':'Confirm that you have the consent of a parent or guardian to provide the athlete\'s details.',
 'Nie możesz zgłosić tego zawodnika.':'You cannot enter this athlete.',
 'Zawodnik ma zgłoszenia w zakończonych turniejach. Usunięcie danych może zlecić Administrator.':'The athlete has entries in finished tournaments. Only the Administrator can have the data deleted.',
 // Clubs (§6.3, §5.5).
 'Klub o podobnej nazwie już istnieje. Wybierz go z listy.':'A club with a similar name already exists. Choose it from the list.',
 'Klub o takiej nazwie już istnieje. Użyj scalania.':'A club with this name already exists. Use merging.',
 'Tego klubu nie można zmienić.':'This club cannot be changed.',
 'Ten klub ma konta personelu. Przypisz je do innego klubu przed scaleniem z „Niezrzeszony”.':'This club has staff accounts. Assign them to another club before merging it into “Unaffiliated”.',
 'Wybierz zawodników.':'Choose athletes.',
 // Athlete profiles of an account and self-entries (§6.1, §7).
 'Wybierz, kogo zgłaszasz.':'Choose whom you are entering.',
 'Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.':'People under 16 are registered by a parent or guardian. Ask them to create the account.',
 'Na jednym koncie może być tylko jeden zawodnik.':'One account can have only one athlete.',
 'Na koncie jest już Twój własny profil zawodnika.':'This account already has your own athlete profile.',
 'Masz zgłoszenia do turniejów, które jeszcze się nie odbyły. Klub, datę urodzenia i płeć zmienisz po turnieju albo po wycofaniu zgłoszenia.':'You have entries in tournaments that have not taken place yet. You can change the club, date of birth and sex after the tournament or after withdrawing the entry.',
 'Najpierw wycofaj zgłoszenia do turniejów, które jeszcze się nie odbyły.':'First withdraw the entries in tournaments that have not taken place yet.',
 'Najpierw uzupełnij dane zawodnika.':'First complete the athlete\'s details.',
 'Jesteś już zgłoszony do tego turnieju.':'You are already entered in this tournament.',
 'Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.':'The draw for this category has already taken place. The organizer can add the entry.',
 'Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.':'The draw for your category has already taken place. The organizer can withdraw the entry.',
 'Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.':'Entries of minors in this tournament will be possible once MatBravo confirms the organizer.',
 'Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.':'Registration is closed. If you do not come, the organizer will mark you absent at check-in.',
 // Tournament log (activity) entries written by the new commands.
 'Zgłoszenie własne: {name}':'Self-entry: {name}',
 'Zmieniono zgłoszenie własne: {name}':'Self-entry changed: {name}',
 'Zmieniono klub w zgłoszeniu: {name}':'Club changed in the entry: {name}',
 'Administrator ukrył turniej.':'The Administrator hid the tournament.',
 'Administrator przywrócił turniej.':'The Administrator restored the tournament.',
 'Konto organizatora zostało usunięte.':'The organizer\'s account was deleted.',
 'Dane usunięte':'Data deleted'
};
