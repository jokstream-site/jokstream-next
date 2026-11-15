# JokStream

واجهة مشاهدة عربية RTL بهوية داكنة وذهبية، مبنية بـ React/Vite مع Express Gateway. الواجهة تقرأ الكتالوج من API بدلاً من عرض قنوات تجريبية، وتعيد استخدام جدول الدردشة الحالي في Supabase.

## بنية المشروع
- `apps/web`: واجهة React + Vite.
- `services/gateway`: API لفحص الحالة، مزامنة كتالوج Xtream مع تصنيفاته، وجلب تفاصيل المسلسلات.
- `spaces/mediaflow-proxy`: قالب مستقل لتشغيل MediaFlow Proxy.
- `docs/DEPLOY_AR.md`: دليل الإعداد والنشر.
- `docs/PROVIDER_FIELDS_AR.md`: بيانات المزود المطلوبة.

## مسارات API الحالية
- `GET /health`: فحص صحة Gateway.
- `GET /api/status`: حالة إعداد المزود والكتالوج.
- `GET /api/catalog?kind=live|movie|series&q=`: تصفية الكتالوج.
- `POST /api/admin/catalog/sync`: مزامنة الكتالوج، يتطلب Bearer token.
- `GET /api/series/:id`: تفاصيل المسلسل وحلقاته.
- `POST /api/playback`: يتحقق من عنصر الكتالوج/الحلقة ويطلب رابط MediaFlow مشفراً ومحدود الصلاحية من جهة الخادم؛ يحتاج بيانات Xtream وMediaFlow وأعلام التفويض.

## إعداد البيئة
- Gateway: انسخ `services/gateway/.env.example` إلى إعدادات بيئة الخادم.
- Web: عيّن `VITE_API_BASE_URL` إلى عنوان Gateway، و`VITE_SUPABASE_URL` و`VITE_SUPABASE_ANON_KEY` للدردشة.
- لا تضع أسرار Xtream أو MediaFlow أو Supabase service-role في متغيرات `VITE_*` أو GitHub.

## التطوير والبناء
```bash
npm install
npm run dev
npm run build
npm run build:gateway
npm run typecheck:gateway
```

## حالة الجاهزية
تم توحيد واجهة المكتبة مع API الكتالوج، وإزالة أسماء القنوات التجريبية، وإضافة تصنيف مزود الخدمة وتفاصيل المسلسلات. **تشغيل الفيديو الفعلي غير مفعّل بعد**: يجب إكمال إنشاء روابط MediaFlow موقعة على الخادم، ثم مشغل HLS/VOD، واختبار البث الحي والأفلام والحلقات قبل النشر العام. لا نعرض مشغلاً يوهم المستخدم بأنه يعمل بينما لا يوجد مسار بث آمن جاهز.

## الأمان
- لا تحفظ كلمات مرور المزود أو مفاتيح service-role في Git.
- لا تضع أسراراً في متغيرات Vite؛ كل `VITE_*` مكشوف للمتصفح.
- لا تفعّل إعادة التوزيع إلا ضمن حقوق المزود وشروط الاستضافة.
