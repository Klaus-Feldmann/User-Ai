CREATE TABLE /*_*/uai_order_counter (
  uaioc_actor INT UNSIGNED NOT NULL,
  uaioc_number BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (uaioc_actor)
) /*$wgDBTableOptions*/;
