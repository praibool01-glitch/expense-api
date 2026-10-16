alter table incomes
  add column created_at timestamptz;

alter table incomes
  alter column created_at set default now();
