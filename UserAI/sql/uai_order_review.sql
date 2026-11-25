CREATE TABLE /*_*/uai_order_review (
  uaior_id VARBINARY(36) NOT NULL,
  uaior_owner INT UNSIGNED NOT NULL,
  uaior_actor INT UNSIGNED NOT NULL,
  uaior_task VARBINARY(120) NOT NULL,
  uaior_phase VARBINARY(10) NOT NULL,
  uaior_text MEDIUMBLOB NOT NULL,
  uaior_status VARBINARY(10) NOT NULL,
  uaior_feedback BLOB NOT NULL,
  uaior_expires BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (uaior_id),
  KEY uaior_pending (uaior_owner, uaior_actor, uaior_status, uaior_expires),
  KEY uaior_expiry (uaior_expires)
) /*$wgDBTableOptions*/;
