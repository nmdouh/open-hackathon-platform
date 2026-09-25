'use strict';

// Starting points for review criteria. Administrators can change everything
// while a round is still a draft. Weights are relative and are normalised to
// a 0-100 total, so they do not have to add up to 100.
const TEMPLATES = {
  screening: [
    { nameEn: 'Clear problem', nameAr: 'وضوح المشكلة', weight: 25,
      descriptionEn: 'A real, specific problem with an identifiable group of people who have it.',
      descriptionAr: 'مشكلة حقيقية ومحددة، وفئة واضحة تعاني منها.' },
    { nameEn: 'Value and impact', nameAr: 'القيمة والأثر', weight: 30,
      descriptionEn: 'How much better things would be if the idea worked, and for how many people.',
      descriptionAr: 'مقدار التحسن لو نجحت الفكرة، وعدد المستفيدين منها.' },
    { nameEn: 'Feasibility in the time available', nameAr: 'قابلية التنفيذ في الوقت المتاح', weight: 25,
      descriptionEn: 'A team can build a convincing first version within the event, with data it can access.',
      descriptionAr: 'يستطيع الفريق بناء نسخة أولى مقنعة خلال الفعالية، وبيانات متاحة له.' },
    { nameEn: 'Fit with the challenge', nameAr: 'الملاءمة لهدف التحدي', weight: 20,
      descriptionEn: 'Matches the goals and tracks the organisers set for this hackathon.',
      descriptionAr: 'تتوافق مع أهداف الفعالية ومساراتها التي حددها المنظمون.' },
  ],
  review: [
    { nameEn: 'Progress against plan', nameAr: 'التقدم مقابل الخطة', weight: 30,
      descriptionEn: 'Working parts exist and the team knows what is left.', descriptionAr: 'توجد أجزاء تعمل، ويعرف الفريق ما تبقى.' },
    { nameEn: 'Technical quality', nameAr: 'الجودة التقنية', weight: 25,
      descriptionEn: 'Sound approach, sensible architecture, tested on real cases.', descriptionAr: 'منهج سليم وبنية معقولة، ومجرّب على حالات حقيقية.' },
    { nameEn: 'User value', nameAr: 'القيمة للمستخدم', weight: 25,
      descriptionEn: 'Evidence that intended users want it and can use it.', descriptionAr: 'أدلة على أن المستخدمين المستهدفين يريدونه ويستطيعون استخدامه.' },
    { nameEn: 'Responsible use of data and AI', nameAr: 'الاستخدام المسؤول للبيانات والذكاء الاصطناعي', weight: 20,
      descriptionEn: 'Privacy, fairness, human oversight and known limits are handled.', descriptionAr: 'مراعاة الخصوصية والعدالة والإشراف البشري وحدود النظام المعروفة.' },
  ],
  final: [
    { nameEn: 'Impact', nameAr: 'الأثر', weight: 30, minScore: 1, maxScore: 10,
      descriptionEn: 'Size and credibility of the benefit, backed by numbers.', descriptionAr: 'حجم الفائدة ومصداقيتها، مدعومة بالأرقام.' },
    { nameEn: 'Working demo', nameAr: 'عرض حي يعمل', weight: 30, minScore: 1, maxScore: 10,
      descriptionEn: 'The critical path runs live, end to end.', descriptionAr: 'يعمل المسار الأساسي مباشرةً من البداية إلى النهاية.' },
    { nameEn: 'Innovation', nameAr: 'الابتكار', weight: 20, minScore: 1, maxScore: 10,
      descriptionEn: 'A new or much better way of solving the problem.', descriptionAr: 'طريقة جديدة أو أفضل بكثير لحل المشكلة.' },
    { nameEn: 'Pitch and readiness', nameAr: 'العرض والجاهزية', weight: 20, minScore: 1, maxScore: 10,
      descriptionEn: 'Clear story, honest limits, a realistic next step.', descriptionAr: 'قصة واضحة، وحدود معلنة بصدق، وخطوة تالية واقعية.' },
  ],
};

module.exports = { TEMPLATES };
