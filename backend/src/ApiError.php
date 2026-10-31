<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * An AppError with extra JSON fields (plan §4.1): the error response is {error, csrf (session routes), ...data},
 * e.g. retry, until, code or portal. Messages stay Polish literals at the throw site (the i18n test finds them there).
 */
class ApiError extends AppError {
 public function __construct(string $message,int $status=422,public array $data=[]){parent::__construct($message,$status);}
}
