<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Change signal of the chat (plan §5.5, §5.11; report 02 §5.7). published() is called after every committed change of a
 * channel (new, deleted, hidden or restored message, status change) with the channel id and its new rev. Clients always
 * fetch the content itself through chat-feed / public-chat with their cursors, so a driver only ever carries a hint.
 * v1 has the driver none (pure polling): nothing happens. Stage 2 (beacon) rewrites the static head file
 * <shared>/live/lobby.json and the guest tail live/c/<public_key>.json here; stage 3 (push) sends {"c":id,"r":rev}
 * to the provider after the response. Both stay out of this release.
 */
final class ChatBus {
 public const DRIVER='none';
 public static function published(int $channelId,int $rev):void{}
}
