# JokStream

واجهة عربية RTL بهوية سينمائية داكنة وذهبية، مع React/Vite، وخدمة Express Gateway أولية، وإعادة استخدام جدول الدردشة الموجود في مشروع Supabase.

## Repository
- `apps/web`: واجهة React + Vite.
- `services/gateway`: API أولي لفحص الحالة ومزامنة كتالوج Xtream.
- `spaces/mediaflow-proxy`: قالب Docker Space لتجربة MediaFlow Proxy.
- `docs/DEPLOY_AR.md`: دليل التشغيل العربي.
- `docs/PROVIDER_FIELDS_AR.md`: الحقول المطلوبة من مزود الاشتراك.

## بيانات Xtream
عند استخدام Xtream Codes تحتاج فقط إلى Server URL وUsername وPassword. لا يلزم رابط M3U منفصل. لا تضع بيانات الاشتراك في GitHub أو المتصفح؛ راجع دليل التشغيل قبل الإعداد.

## Development
```bash
npm install
npm run dev
```

## Current readiness — مهم
هذه نسخة تأسيسية وليست إصداراً إنتاجياً جاهزاً للبث. خدمة Gateway الحالية تنفذ فحص الحالة ومزامنة أولية للكتالوج، لكن مسارات تشغيل القنوات والأفلام والحلقات وربط MediaFlow بالبوابة واختبارات التحمل لم تكتمل بعد. لا تنشر روابط بث للجمهور قبل استكمال ذلك واختباره.

## Deployment
راجع [دليل التشغيل العربي](docs/DEPLOY_AR.md) و[حقول المزود](docs/PROVIDER_FIELDS_AR.md).

## Security
- لا تحفظ كلمات مرور المزود أو مفاتيح service-role في Git.
- لا تضع أسراراً في متغيرات Vite؛ متغيرات `VITE_*` مكشوفة للمتصفح.
- لا تفعّل إعادة التوزيع إلا وفق حقوق المزود وشروط الاستضافة.
