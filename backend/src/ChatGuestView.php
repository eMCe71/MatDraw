<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Chat projection for guests and for signed-in people without full access (plan §5.4, D6; like GuestView for tournaments).
 * A message is exactly {id, r, t, g, c, b}; a tombstone is exactly {id, r, t, g, x}:
 *   id  message id (display order)            r  rev of its last change (polling cursor)
 *   t   time in epoch milliseconds            b  the text (public by product decision, requirement 3)
 *   c   1 = same author as the previous visible message, less than 5 minutes earlier and of the same UTC day (computed
 *       when it was written; never across the UTC midnight that changes g)
 *   g   decoration variant 0–4 of the placeholder avatar and name bar
 *   x   tombstone kind: author (deleted by its author), mod (deleted by a moderator), review (hidden pending review)
 * Never sent here: names, initials, usernames, public_id, internal user ids, e-mails, avatars, countries, sports, clubs,
 * roles (moderator, organiser), report counts, client ids, the text of deleted or hidden messages, people{}.
 * What g and c reveal (documented on purpose, not hidden): g = HMAC-SHA256(app_key, 'chatghost|<UTC day of the
 * message>|<channel id>|<user id>') mod 5, so it is the same for every message of one person in one channel on one day.
 * Together with c and the times, a guest can group the messages of one person within that channel and day (5 variants
 * shared by all authors). It cannot be linked across channels or days, and g holds no identity. A variant drawn per
 * message would make one conversation look like many people talking: the readability trade-off accepted in D6.
 */
final class ChatGuestView {
 public const FIELDS=['id','r','t','g','c','b'],TOMBSTONE=['id','r','t','g','x'];
 /** Tombstone kind per stored state (also used by the member projection). */
 public const X=['deleted_author'=>'author','deleted_mod'=>'mod','hidden_review'=>'review'];
 public static function variant(string $appKey,int $createdMs,int $channelId,string $userId):int {
  return hexdec(substr(hash_hmac('sha256','chatghost|'.gmdate('Y-m-d',intdiv($createdMs,1000)).'|'.$channelId.'|'.$userId,$appKey),0,8))%5;
 }
 /** One chat_messages row (id, rev, user_id, body, cont, state, created_ms) of channel $channelId for a guest. */
 public static function message(array $m,int $channelId,string $appKey):array {
  $out=['id'=>(int)$m['id'],'r'=>(int)$m['rev'],'t'=>(int)$m['created_ms'],'g'=>self::variant($appKey,(int)$m['created_ms'],$channelId,(string)$m['user_id'])];
  return ($m['state']??'visible')==='visible'?$out+['c'=>(int)$m['cont'],'b'=>(string)$m['body']]:$out+['x'=>self::X[$m['state']]??'mod'];
 }
}
