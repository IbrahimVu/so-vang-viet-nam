-- Hosted Supabase Cron uses UTC. Run once per five-minute slot, including 08:30 and 20:30 ICT.
select cron.schedule('gold-scan-morning', '30-55/5 1 * * *', 'select gold_private.enqueue_scan(false)');
select cron.schedule('gold-scan-day', '*/5 2-12 * * *', 'select gold_private.enqueue_scan(false)');
select cron.schedule('gold-scan-evening', '0-30/5 13 * * *', 'select gold_private.enqueue_scan(false)');
