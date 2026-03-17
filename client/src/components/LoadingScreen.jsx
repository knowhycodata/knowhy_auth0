import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function LoadingScreen() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-dark-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 animate-fade-in">
        <div className="w-16 h-16 bg-primary-600/20 rounded-2xl flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
        </div>
        <div className="text-center">
          <h2 className="text-xl font-semibold text-white">Knowhy</h2>
          <p className="text-dark-400 text-sm mt-1">{t('common.loading')}</p>
        </div>
      </div>
    </div>
  );
}
