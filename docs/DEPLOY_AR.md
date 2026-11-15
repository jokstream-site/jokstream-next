# تشغيل JokStream — دليل عربي

## الوضع الحالي

الواجهة تقرأ الكتالوج من Gateway وتعرض تصنيفات القنوات والأفلام والمسلسلات القادمة من مزود Xtream، وأضيف مسار تفاصيل المسلسل. لكن التشغيل الفعلي للفيديو ما زال معطلاً عمداً إلى أن يكتمل توقيع روابط MediaFlow من الخادم ومشغل HLS/VOD واختبار تدفق الفيديو.

## بيانات اشتراك Xtream المطلوبة

إذا كان اشتراكك من نوع Xtream Codes، فالمعلومات الأساسية هي ثلاثة فقط:

1. رابط الخادم/البوابة (Server URL أو Portal URL)، مثال شكلي: `https://provider.example:port`
2. اسم المستخدم.
3. كلمة المرور.

**لا تحتاج إلى رابط M3U منفصل** إذا كان مزودك يعطيك بيانات Xtream الثلاثة. رابط M3U طريقة بديلة لبعض المزودين، وليس مطلوباً بالإضافة إليها.

لا ترسل هذه البيانات في المحادثة، ولا تضعها في ملفات GitHub أو متغيرات Vite التي تبدأ بـ `VITE_`، لأنها تصل إلى المتصفح.

## أين توضع الأسرار؟

- بيانات Xtream يجب أن توضع كـ Secrets في خدمة Gateway الخاصة بالخادم.
- `MEDIAFLOW_BASE_URL` و`MEDIAFLOW_API_PASSWORD` يوضعان كـ Secrets/Environment Variables في Gateway. كلمة مرور MediaFlow نفسها يجب أن تطابق `API_PASSWORD` في MediaFlow.
- اضبط `ALLOWED_ORIGINS` على نطاق الواجهة المنشور، واضبط `UPSTREAM_REDISTRIBUTION_AUTHORIZED=true` فقط بعد التأكد من أن الاستضافة تسمح بالبث وإعادة التوزيع.
- `API_PASSWORD` الخاص بـ MediaFlow يوضع في Hugging Face Space الخاص بـ MediaFlow من Settings → Variables and secrets → New secret.
- مفتاح Supabase anon/publishable فقط يوضع في متغيرات الواجهة. لا تستخدم service_role في الواجهة.

في النسخة الحالية من المستودع، Gateway تقرأ `XTREAM_BASE_URL`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` من بيئة الخادم، لكنها لا توفر بعد صفحة إعدادات آمنة لحفظ بيانات المزود من لوحة الإدارة. لا تضعها في GitHub Secrets على أنها جاهزة للتشغيل ما لم يتم نشر Gateway على runner يقرأ تلك الأسرار فعلاً.


## إعداد Gateway للإطلاق التجريبي

في Render → خدمة `jokstream-gateway` → Environment، أضف القيم التالية كمتغيرات بيئة. لا ترسل القيم السرية في المحادثة:

- `ADMIN_API_TOKEN`: رمز عشوائي طويل لا يقل عن 32 حرفاً.
- `XTREAM_BASE_URL`: رابط Server URL الخاص بالمزود.
- `XTREAM_USERNAME`: اسم المستخدم.
- `XTREAM_PASSWORD`: كلمة المرور.
- `MEDIAFLOW_BASE_URL`: عنوان MediaFlow المنشور مع `https://`.
- `MEDIAFLOW_API_PASSWORD`: نفس قيمة `API_PASSWORD` في MediaFlow.
- `UPSTREAM_REDISTRIBUTION_AUTHORIZED=true`: لا تفعّله إلا بعد تحققك من حقوق المزود وشروط الاستضافة معاً.
- `ALLOWED_ORIGINS=https://jokstream-web.onrender.com`: نطاق الواجهة الحالية.

بعد حفظ المتغيرات، نفّذ Deploy للخدمة. افتح الموقع ثم «لوحة الإدارة» في أسفل الصفحة، والصق `ADMIN_API_TOKEN` واضغط «مزامنة الكتالوج». رمز الإدارة يُستخدم في الجلسة فقط ولا يُحفظ في Local Storage.

## إعداد الواجهة

تم إعداد `VITE_API_BASE_URL` وSupabase URL ومفتاح Supabase Publishable العام في خدمة الواجهة. لا تضع مفتاح `service_role` أو أي كلمة مرور مزود في الواجهة.

## إنشاء MediaFlow Space

1. أنشئ Hugging Face Space جديداً.
2. اختر SDK: Docker.
3. ارفع محتويات المجلد `spaces/mediaflow-proxy` إلى جذر Space (ملفا README.md وDockerfile).
4. من Space → Settings → Variables and secrets، أضف Secret باسم `API_PASSWORD` وقيمة طويلة وعشوائية.
5. انتظر اكتمال البناء، ثم افتح Logs إذا فشل.
6. اختبر أن Space يعمل. لا تعتبر نجاح صفحة Space دليلاً على نجاح تشغيل قنوات مزودك.

## حدود الاستضافة المجانية

Hugging Face Spaces المجانية قد تدخل في وضع السكون عند عدم الاستخدام، والقرص الافتراضي غير دائم. كما أن قيود الشبكة والموارد تجعلها مناسبة للتجارب الأولية، لا ضماناً لبث تجاري دائم أو عدد مشاهدين محدد. راجع وثائق Hugging Face قبل الإطلاق:
https://huggingface.co/docs/hub/spaces-overview
https://huggingface.co/docs/hub/spaces-sdks-docker

## لا تنشر البث قبل هذه الاختبارات

- صحة بيانات المزود وتوفر API.
- القنوات الحية وملفات HLS وقِطع الفيديو والمفاتيح.
- الأفلام وحلقات المسلسلات.
- انتهاء صلاحية الرموز، CORS، الترويسات، والاتصالات الطويلة.
- اختبار عدة مشاهدين بالتزامن وحدود موارد Space.
- تأكيد أن خطة الاستضافة تسمح بالاستخدام التجاري وحركة الفيديو المطلوبة.
