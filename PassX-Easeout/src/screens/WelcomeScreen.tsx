import React from 'react';
import { View, Text, StyleSheet, Image, Dimensions, SafeAreaView } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BlurView } from 'expo-blur'; 
import CustomButton from '../components/CustomButton';
import colors from '../constants/colors';
import { RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

const { height, width } = Dimensions.get('window');

const WelcomeScreen: React.FC<Props> = ({ navigation }) => {
  return (
    <View style={styles.container}>
      
      {/* 1. BACKGROUND LAYER */}
      <View style={styles.backgroundContainer}>
        <Image 
          // Replace with your local asset: require('../../assets/welcome_doodle.png')
          source={{ uri: 'https://img.freepik.com/free-vector/teamwork-concept-illustration_114360-1253.jpg' }}
          style={styles.backgroundImage}
          resizeMode="cover" 
        />
        <View style={styles.tealOverlay} />
      </View>

      {/* 2. FOREGROUND CONTENT */}
      <SafeAreaView style={styles.contentContainer}>
        
        <View style={styles.topSpacer} />

        {/* 3. GLASS CARD */}
        <BlurView intensity={80} tint="light" style={styles.glassCard}>
          <View style={styles.cardContent}>
            <Text style={styles.logoText}>EASE OUT</Text>

            <Text style={styles.headline}>
              Let’s Get You Set Up{'\n'}for Success
            </Text>

            <Text style={styles.description}>
              Organize your workflow and manage tasks easily{'\n'}all in one simple, powerful app.
            </Text>
            
            <View style={styles.buttonContainer}>
              <CustomButton 
                title="Get Started" 
                onPress={() => navigation.navigate('Login')} 
              />
            </View>
          </View>
        </BlurView>
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.primary,
  },
  backgroundContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  backgroundImage: {
    width: width,
    height: height * 0.7, 
    marginTop: 50,     
  },
  tealOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(36, 182, 184, 0.2)', 
  },
  contentContainer: {
    flex: 1,
    justifyContent: 'flex-end', 
  },
  topSpacer: {
    flex: 1, 
  },
  glassCard: {
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden', 
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.65)', 
  },
  cardContent: {
    paddingVertical: 40,
    paddingHorizontal: 30,
    alignItems: 'center',
  },
  logoText: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.primaryDark, 
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 15,
  },
  headline: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#2C3E50',
    textAlign: 'center',
    lineHeight: 34,
    marginBottom: 15,
  },
  description: {
    fontSize: 15,
    color: '#546E7A',
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 10,
    marginBottom: 30,
  },
  buttonContainer: {
    width: '100%',
  },
});

export default WelcomeScreen;